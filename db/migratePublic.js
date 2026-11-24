function claveDe(tabla, id) {
    return `${tabla}:${id}`;
}

async function tablaExiste(client, nombre) {
    const { rows } = await client.query('SELECT to_regclass($1) IS NOT NULL AS existe', [`public.${nombre}`]);
    return rows[0].existe;
}

async function cargarMapas(client) {
    const { rows } = await client.query(
        'SELECT source_table, source_id, target_id FROM public_migration_map'
    );
    const mapas = new Map();

    for (const fila of rows) {
        mapas.set(claveDe(fila.source_table, fila.source_id), fila.target_id);
    }

    return mapas;
}

async function guardarMapa(client, mapas, tabla, idOrigen, idDestino) {
    await client.query(
        `INSERT INTO public_migration_map (source_table, source_id, target_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (source_table, source_id) DO NOTHING`,
        [tabla, idOrigen, idDestino]
    );

    const { rows } = await client.query(
        `SELECT target_id FROM public_migration_map
         WHERE source_table = $1 AND source_id = $2`,
        [tabla, idOrigen]
    );
    mapas.set(claveDe(tabla, idOrigen), rows[0].target_id);
    return rows[0].target_id;
}

function mapaRequerido(mapas, tabla, idOrigen) {
    const id = mapas.get(claveDe(tabla, idOrigen));
    if (id === undefined) {
        throw new Error(`No se pudo relacionar ${tabla} con el registro migrado ${idOrigen}`);
    }
    return id;
}

function estadoPedido(estado) {
    const estados = {
        pendiente: 'pending',
        aprobado: 'approved',
        rechazado: 'rejected',
        cancelado: 'cancelled',
        entregado: 'delivered'
    };
    const resultado = estados[estado];
    if (!resultado) {
        throw new Error(`Estado de pedido no reconocido durante la migración: ${estado}`);
    }
    return resultado;
}

async function migrarRolesYPermisos(client, mapas) {
    if (await tablaExiste(client, 'roles')) {
        const { rows } = await client.query(
            'SELECT id, nombre, descripcion, es_sistema, creado_en FROM public.roles ORDER BY id'
        );

        for (const fila of rows) {
            if (mapas.has(claveDe('roles', fila.id))) {
                continue;
            }

            await client.query(
                `INSERT INTO roles (name, description, is_system, created_at)
                 VALUES ($1, $2, $3, COALESCE($4, NOW()))
                 ON CONFLICT (name) DO NOTHING`,
                [fila.nombre, fila.descripcion || '', Boolean(fila.es_sistema), fila.creado_en]
            );
            const destino = await client.query('SELECT id FROM roles WHERE name = $1', [fila.nombre]);
            await guardarMapa(client, mapas, 'roles', fila.id, destino.rows[0].id);
        }
    }

    if (await tablaExiste(client, 'permisos')) {
        const { rows } = await client.query(
            'SELECT id, codigo, descripcion FROM public.permisos ORDER BY id'
        );

        for (const fila of rows) {
            if (mapas.has(claveDe('permisos', fila.id))) {
                continue;
            }

            await client.query(
                `INSERT INTO permisos (nombre_permiso, codigo, descripcion)
                 VALUES ($1, $2, $3)
                 ON CONFLICT DO NOTHING`,
                [String(fila.codigo).slice(0, 45), fila.codigo, fila.descripcion || '']
            );
            const destino = await client.query('SELECT id_permiso FROM permisos WHERE codigo = $1', [fila.codigo]);
            if (!destino.rows[0]) {
                throw new Error(`No se pudo migrar el permiso ${fila.codigo}`);
            }
            await guardarMapa(client, mapas, 'permisos', fila.id, destino.rows[0].id_permiso);
        }
    }

    if (await tablaExiste(client, 'rol_permiso')) {
        const { rows } = await client.query(
            'SELECT rol_id, permiso_id FROM public.rol_permiso ORDER BY rol_id, permiso_id'
        );
        const privilegio = await client.query(
            "SELECT id_privilegio FROM privilegios WHERE nombre_privilegio = 'permitir'"
        );

        if (!privilegio.rows[0]) {
            throw new Error('No existe el privilegio base para migrar permisos de roles');
        }

        for (const fila of rows) {
            const rolId = mapaRequerido(mapas, 'roles', fila.rol_id);
            const permisoId = mapaRequerido(mapas, 'permisos', fila.permiso_id);
            await client.query(
                `INSERT INTO asignacion_rol (rol_id, permiso_id, privilegio_id)
                 VALUES ($1, $2, $3)
                 ON CONFLICT DO NOTHING`,
                [rolId, permisoId, privilegio.rows[0].id_privilegio]
            );
        }
    }
}

async function migrarUsuarios(client, mapas) {
    if (!(await tablaExiste(client, 'usuarios'))) {
        return;
    }

    const { rows } = await client.query(
        `SELECT id, nombre, correo, telefono, password_hash, rol_id, activo,
                intentos_fallidos, bloqueado_hasta, creado_en
         FROM public.usuarios
         ORDER BY id`
    );

    for (const fila of rows) {
        if (mapas.has(claveDe('usuarios', fila.id))) {
            continue;
        }

        const rolId = mapaRequerido(mapas, 'roles', fila.rol_id);
        await client.query(
            `INSERT INTO usuario (
                roles_idroles, nombre_completo, correo, telefono, clave_hash,
                estado, failed_login_attempts, locked_until, created_at
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, NOW()))
             ON CONFLICT DO NOTHING`,
            [
                rolId,
                fila.nombre,
                fila.correo,
                fila.telefono || '',
                fila.password_hash,
                fila.activo,
                fila.intentos_fallidos || 0,
                fila.bloqueado_hasta,
                fila.creado_en
            ]
        );
        const destino = await client.query(
            'SELECT id_usuario FROM usuario WHERE LOWER(correo) = LOWER($1)',
            [fila.correo]
        );
        if (!destino.rows[0]) {
            throw new Error(`No se pudo migrar el usuario con id ${fila.id}`);
        }
        await guardarMapa(client, mapas, 'usuarios', fila.id, destino.rows[0].id_usuario);
    }
}

async function migrarClientes(client, mapas) {
    if (!(await tablaExiste(client, 'clientes'))) {
        return;
    }

    const { rows } = await client.query(
        `SELECT id, tipo, nombre, razon_social, documento, telefono, correo,
                direccion, usuario_id, activo, creado_en
         FROM public.clientes
         ORDER BY id`
    );

    for (const fila of rows) {
        if (mapas.has(claveDe('clientes', fila.id))) {
            continue;
        }

        const usuarioId = fila.usuario_id === null
            ? null
            : mapaRequerido(mapas, 'usuarios', fila.usuario_id);
        await client.query(
            `INSERT INTO clientes (
                usuario_id, tipo_persona, tipo_documento, num_documento,
                nombre_o_razon_social, business_name, telefono, correo,
                direccion_entrega, estado, created_at
             )
             VALUES ($1, $2, 'otro', $3, $4, $5, $6, $7, $8, $9, COALESCE($10, NOW()))
             ON CONFLICT DO NOTHING`,
            [
                usuarioId,
                fila.tipo || 'persona',
                String(fila.documento),
                fila.nombre,
                fila.razon_social,
                fila.telefono || '',
                fila.correo || '',
                fila.direccion || '',
                fila.activo,
                fila.creado_en
            ]
        );

        let destino;
        if (usuarioId !== null) {
            destino = await client.query('SELECT id_clientes FROM clientes WHERE usuario_id = $1', [usuarioId]);
        }
        if (!destino || !destino.rows[0]) {
            destino = await client.query(
                `SELECT id_clientes FROM clientes
                 WHERE tipo_documento = 'otro' AND num_documento = $1`,
                [String(fila.documento)]
            );
        }
        if (!destino.rows[0]) {
            throw new Error(`No se pudo migrar el cliente con id ${fila.id}`);
        }
        await guardarMapa(client, mapas, 'clientes', fila.id, destino.rows[0].id_clientes);
    }
}

async function migrarCategorias(client, mapas) {
    if (!(await tablaExiste(client, 'categorias'))) {
        return;
    }

    const { rows } = await client.query(
        'SELECT id, nombre, descripcion, activo, creado_en FROM public.categorias ORDER BY id'
    );
    for (const fila of rows) {
        if (mapas.has(claveDe('categorias', fila.id))) {
            continue;
        }
        await client.query(
            `INSERT INTO categoria_producto (nombre_categoria, descripcion, estado, created_at)
             VALUES ($1, $2, $3, COALESCE($4, NOW()))
             ON CONFLICT (nombre_categoria) DO NOTHING`,
            [fila.nombre, fila.descripcion || '', fila.activo, fila.creado_en]
        );
        const destino = await client.query(
            'SELECT id_categoria_producto FROM categoria_producto WHERE nombre_categoria = $1',
            [fila.nombre]
        );
        await guardarMapa(client, mapas, 'categorias', fila.id, destino.rows[0].id_categoria_producto);
    }
}

async function migrarProductos(client, mapas) {
    if (!(await tablaExiste(client, 'productos'))) {
        return;
    }

    const { rows } = await client.query(
        `SELECT id, categoria_id, nombre, descripcion, precio, stock, stock_minimo,
                activo, creado_en
         FROM public.productos
         ORDER BY id`
    );
    let categoriaSinAsignar = null;

    for (const fila of rows) {
        if (mapas.has(claveDe('productos', fila.id))) {
            continue;
        }

        let categoriaId;
        if (fila.categoria_id === null) {
            if (categoriaSinAsignar === null) {
                await client.query(
                    `INSERT INTO categoria_producto (nombre_categoria, descripcion)
                     VALUES ('Sin categoría (migración)', 'Categoría para productos migrados sin categoría')
                     ON CONFLICT (nombre_categoria) DO NOTHING`
                );
                const categoria = await client.query(
                    `SELECT id_categoria_producto FROM categoria_producto
                     WHERE nombre_categoria = 'Sin categoría (migración)'`
                );
                categoriaSinAsignar = categoria.rows[0].id_categoria_producto;
            }
            categoriaId = categoriaSinAsignar;
        } else {
            categoriaId = mapaRequerido(mapas, 'categorias', fila.categoria_id);
        }

        const sku = `MIG-PUBLIC-${fila.id}`;
        await client.query(
            `INSERT INTO productos (
                categoria_producto_id, sku, nombre_producto, descripcion,
                precio_base, existencias, stock_minimo, estado, created_at
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, NOW()))
             ON CONFLICT (sku) DO NOTHING`,
            [
                categoriaId,
                sku,
                fila.nombre,
                fila.descripcion || '',
                fila.precio,
                fila.stock,
                fila.stock_minimo || 0,
                fila.activo,
                fila.creado_en
            ]
        );
        const destino = await client.query('SELECT id_producto FROM productos WHERE sku = $1', [sku]);
        await guardarMapa(client, mapas, 'productos', fila.id, destino.rows[0].id_producto);
    }
}

async function migrarProveedores(client, mapas) {
    if (!(await tablaExiste(client, 'proveedores'))) {
        return;
    }

    const { rows } = await client.query(
        'SELECT id, nombre, correo, telefono, direccion, activo, creado_en FROM public.proveedores ORDER BY id'
    );
    for (const fila of rows) {
        if (mapas.has(claveDe('proveedores', fila.id))) {
            continue;
        }

        const documento = `MIG-PUBLIC-${fila.id}`;
        await client.query(
            `INSERT INTO proveedores (
                tipo_de_documento, num_documento, nombre, telefono, correo,
                direccion, estado, created_at
             )
             VALUES ('otro', $1, $2, $3, $4, $5, $6, COALESCE($7, NOW()))
             ON CONFLICT (tipo_de_documento, num_documento) DO NOTHING`,
            [documento, fila.nombre, fila.telefono || '', fila.correo || '', fila.direccion || '', fila.activo, fila.creado_en]
        );
        const destino = await client.query(
            `SELECT id_proveedores FROM proveedores
             WHERE tipo_de_documento = 'otro' AND num_documento = $1`,
            [documento]
        );
        await guardarMapa(client, mapas, 'proveedores', fila.id, destino.rows[0].id_proveedores);
    }
}

async function migrarRelacionProveedorProducto(client, mapas) {
    if (!(await tablaExiste(client, 'proveedor_producto'))) {
        return;
    }

    const { rows } = await client.query(
        'SELECT proveedor_id, producto_id, costo_adquisicion FROM public.proveedor_producto'
    );
    for (const fila of rows) {
        const proveedorId = mapaRequerido(mapas, 'proveedores', fila.proveedor_id);
        const productoId = mapaRequerido(mapas, 'productos', fila.producto_id);
        await client.query(
            `INSERT INTO proveedor_producto (proveedor_id, producto_id, costo_adquisicion)
             VALUES ($1, $2, $3)
             ON CONFLICT DO NOTHING`,
            [proveedorId, productoId, fila.costo_adquisicion]
        );
    }
}

async function migrarCompras(client, mapas) {
    if (!(await tablaExiste(client, 'compras'))) {
        return;
    }

    const { rows } = await client.query(
        'SELECT id, proveedor_id, usuario_id, fecha, total, estado FROM public.compras ORDER BY id'
    );
    for (const fila of rows) {
        if (mapas.has(claveDe('compras', fila.id))) {
            continue;
        }
        const proveedorId = mapaRequerido(mapas, 'proveedores', fila.proveedor_id);
        const usuarioId = fila.usuario_id === null ? null : mapaRequerido(mapas, 'usuarios', fila.usuario_id);
        const estado = fila.estado === 'anulada' ? 'cancelled' : 'received';
        const compra = await client.query(
            `INSERT INTO compra (
                proveedores_idproveedores, fecha_compra, valor_total,
                estado, estado_compra, recibido_en, created_by
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING id_compra`,
            [
                proveedorId,
                fila.fecha,
                fila.total,
                fila.estado !== 'anulada',
                estado,
                estado === 'received' ? fila.fecha : null,
                usuarioId
            ]
        );
        await guardarMapa(client, mapas, 'compras', fila.id, compra.rows[0].id_compra);
    }

    if (!(await tablaExiste(client, 'compra_detalle'))) {
        return;
    }

    const detalles = await client.query(
        `SELECT id, compra_id, producto_id, cantidad, costo_unitario
         FROM public.compra_detalle
         ORDER BY id`
    );
    for (const fila of detalles.rows) {
        if (mapas.has(claveDe('compra_detalle', fila.id))) {
            continue;
        }
        const compraId = mapaRequerido(mapas, 'compras', fila.compra_id);
        const productoId = mapaRequerido(mapas, 'productos', fila.producto_id);
        const existente = await client.query(
            `SELECT id_detalle_compra, cantidad, precio_unitario
             FROM detalle_compra
             WHERE compra_idcompra = $1 AND productos_idproducto = $2`,
            [compraId, productoId]
        );

        let detalleId;
        if (existente.rows[0]) {
            const actual = existente.rows[0];
            const actualizado = await client.query(
                `UPDATE detalle_compra
                 SET precio_unitario = ROUND(
                         (cantidad * precio_unitario + $1 * $2) / (cantidad + $1), 4
                     ),
                     cantidad = cantidad + $1
                 WHERE id_detalle_compra = $3 AND productos_idproducto = $4
                 RETURNING id_detalle_compra`,
                [fila.cantidad, fila.costo_unitario, actual.id_detalle_compra, productoId]
            );
            detalleId = actualizado.rows[0].id_detalle_compra;
        } else {
            const insertado = await client.query(
                `INSERT INTO detalle_compra (
                    compra_idcompra, productos_idproducto, cantidad, precio_unitario
                 )
                 VALUES ($1, $2, $3, $4)
                 RETURNING id_detalle_compra`,
                [compraId, productoId, fila.cantidad, fila.costo_unitario]
            );
            detalleId = insertado.rows[0].id_detalle_compra;
        }
        await guardarMapa(client, mapas, 'compra_detalle', fila.id, detalleId);
    }
}

async function migrarCarritos(client, mapas) {
    if (!(await tablaExiste(client, 'carritos'))) {
        return;
    }

    const { rows } = await client.query(
        'SELECT id, usuario_id, actualizado_en FROM public.carritos ORDER BY id'
    );
    for (const fila of rows) {
        if (mapas.has(claveDe('carritos', fila.id))) {
            continue;
        }
        const usuarioId = mapaRequerido(mapas, 'usuarios', fila.usuario_id);
        await client.query(
            `INSERT INTO carritos (usuario_id, updated_at)
             VALUES ($1, COALESCE($2, NOW()))
             ON CONFLICT (usuario_id) DO NOTHING`,
            [usuarioId, fila.actualizado_en]
        );
        const destino = await client.query('SELECT id_carrito FROM carritos WHERE usuario_id = $1', [usuarioId]);
        await guardarMapa(client, mapas, 'carritos', fila.id, destino.rows[0].id_carrito);
    }

    if (!(await tablaExiste(client, 'carrito_detalle'))) {
        return;
    }

    const { rows: detalles } = await client.query(
        'SELECT id, carrito_id, producto_id, cantidad FROM public.carrito_detalle ORDER BY id'
    );
    for (const fila of detalles) {
        if (mapas.has(claveDe('carrito_detalle', fila.id))) {
            continue;
        }
        const carritoId = mapaRequerido(mapas, 'carritos', fila.carrito_id);
        const productoId = mapaRequerido(mapas, 'productos', fila.producto_id);
        const existente = await client.query(
            `SELECT id_detalle_carrito, cantidad FROM detalle_carrito
             WHERE carrito_id = $1 AND productos_idproducto = $2`,
            [carritoId, productoId]
        );
        let detalleId;
        if (existente.rows[0]) {
            const cantidad = existente.rows[0].cantidad + fila.cantidad;
            if (cantidad > 999) {
                throw new Error(`La cantidad combinada del producto ${productoId} en un carrito supera 999`);
            }
            await client.query(
                'UPDATE detalle_carrito SET cantidad = $1 WHERE id_detalle_carrito = $2',
                [cantidad, existente.rows[0].id_detalle_carrito]
            );
            detalleId = existente.rows[0].id_detalle_carrito;
        } else {
            const insertado = await client.query(
                `INSERT INTO detalle_carrito (carrito_id, productos_idproducto, cantidad)
                 VALUES ($1, $2, $3)
                 RETURNING id_detalle_carrito`,
                [carritoId, productoId, fila.cantidad]
            );
            detalleId = insertado.rows[0].id_detalle_carrito;
        }
        await guardarMapa(client, mapas, 'carrito_detalle', fila.id, detalleId);
    }
}

async function migrarPedidos(client, mapas) {
    if (!(await tablaExiste(client, 'pedidos'))) {
        return;
    }

    const { rows } = await client.query(
        `SELECT id, cliente_id, usuario_id, fecha, estado, total, direccion_entrega,
                notas, aprobado_por, entregado_en,
                to_jsonb(p)->>'decidido_en' AS decidido_en,
                to_jsonb(p)->>'aprobado_en' AS aprobado_en,
                to_jsonb(p)->>'registrado_por' AS registrado_por
         FROM public.pedidos p
         ORDER BY id`
    );
    for (const fila of rows) {
        if (mapas.has(claveDe('pedidos', fila.id))) {
            continue;
        }
        const clienteId = mapaRequerido(mapas, 'clientes', fila.cliente_id);
        const usuarioId = fila.usuario_id === null ? null : mapaRequerido(mapas, 'usuarios', fila.usuario_id);
        const aprobadoPor = fila.aprobado_por === null ? null : mapaRequerido(mapas, 'usuarios', fila.aprobado_por);
        const registradoPorOrigen = fila.registrado_por === null ? null : Number(fila.registrado_por);
        const registradoPor = registradoPorOrigen === null
            ? usuarioId
            : mapaRequerido(mapas, 'usuarios', registradoPorOrigen);
        const status = estadoPedido(fila.estado);
        const pedido = await client.query(
            `INSERT INTO pedido_venta (
                clientes_idclientes, usuario_id, fecha, estado_pedido, valor_total,
                direccion_entrega, notas, decidido_por, decidido_en, entregado_en,
                registrado_por
             )
             VALUES ($1, $2, COALESCE($3, NOW()), $4, $5, $6, $7, $8, $9, $10, $11)
             RETURNING id_pedido`,
            [
                clienteId,
                usuarioId,
                fila.fecha,
                status,
                fila.total,
                fila.direccion_entrega || '',
                fila.notas,
                aprobadoPor,
                fila.decidido_en || fila.aprobado_en || null,
                fila.entregado_en,
                registradoPor
            ]
        );
        await guardarMapa(client, mapas, 'pedidos', fila.id, pedido.rows[0].id_pedido);
    }

    if (!(await tablaExiste(client, 'pedido_detalle'))) {
        return;
    }

    const { rows: detalles } = await client.query(
        `SELECT id, pedido_id, producto_id, nombre, precio_unitario, cantidad
         FROM public.pedido_detalle
         ORDER BY id`
    );
    for (const fila of detalles) {
        if (mapas.has(claveDe('pedido_detalle', fila.id))) {
            continue;
        }
        const pedidoId = mapaRequerido(mapas, 'pedidos', fila.pedido_id);
        const productoId = mapaRequerido(mapas, 'productos', fila.producto_id);
        const existente = await client.query(
            `SELECT id_detalle_pedido, cantidad, precio_unitario
             FROM detalle_pedido_venta
             WHERE pedido_id_pedido = $1 AND productos_idproducto = $2`,
            [pedidoId, productoId]
        );
        let detalleId;
        if (existente.rows[0]) {
            const actual = existente.rows[0];
            const actualizado = await client.query(
                `UPDATE detalle_pedido_venta
                 SET precio_unitario = ROUND(
                         (cantidad * precio_unitario + $1 * $2) / (cantidad + $1), 2
                     ),
                     cantidad = cantidad + $1
                 WHERE id_detalle_pedido = $3
                 RETURNING id_detalle_pedido`,
                [fila.cantidad, fila.precio_unitario, actual.id_detalle_pedido]
            );
            detalleId = actualizado.rows[0].id_detalle_pedido;
        } else {
            const insertado = await client.query(
                `INSERT INTO detalle_pedido_venta (
                    pedido_id_pedido, productos_idproducto, nombre_producto,
                    precio_unitario, cantidad
                 )
                 VALUES ($1, $2, $3, $4, $5)
                 RETURNING id_detalle_pedido`,
                [pedidoId, productoId, fila.nombre, fila.precio_unitario, fila.cantidad]
            );
            detalleId = insertado.rows[0].id_detalle_pedido;
        }
        await guardarMapa(client, mapas, 'pedido_detalle', fila.id, detalleId);
    }
}

async function migrarVentas(client, mapas) {
    if (!(await tablaExiste(client, 'ventas'))) {
        return;
    }

    const { rows } = await client.query(
        `SELECT id, pedido_id, usuario_id, fecha, estado
         FROM public.ventas
         ORDER BY id`
    );
    const estadosPorPedido = new Map();
    for (const fila of rows) {
        const pedidoId = mapaRequerido(mapas, 'pedidos', fila.pedido_id);
        const actual = estadosPorPedido.get(pedidoId) || { activa: false, anulada: false, anuladaEn: null, anuladaPor: null };
        if (fila.estado === 'activa') {
            actual.activa = true;
        } else if (fila.estado === 'anulada') {
            actual.anulada = true;
            actual.anuladaEn = fila.fecha;
            actual.anuladaPor = fila.usuario_id === null ? null : mapaRequerido(mapas, 'usuarios', fila.usuario_id);
        }
        estadosPorPedido.set(pedidoId, actual);
        await guardarMapa(client, mapas, 'ventas', fila.id, pedidoId);
    }

    for (const [pedidoId, estado] of estadosPorPedido) {
        if (estado.activa) {
            await client.query(
                `UPDATE pedido_venta
                 SET estado_pedido = 'delivered',
                     entregado_en = COALESCE(entregado_en, fecha)
                 WHERE id_pedido = $1`,
                [pedidoId]
            );
        } else if (estado.anulada) {
            await client.query(
                `UPDATE pedido_venta SET estado_pedido = 'approved'
                 WHERE id_pedido = $1`,
                [pedidoId]
            );
            await client.query(
                `INSERT INTO venta_anulada (pedido_id, usuario_id, anulada_en)
                 VALUES ($1, $2, COALESCE($3, NOW()))
                 ON CONFLICT (pedido_id) DO NOTHING`,
                [pedidoId, estado.anuladaPor, estado.anuladaEn]
            );
        }
    }

    if (!(await tablaExiste(client, 'venta_detalle'))) {
        return;
    }

    const { rows: detalles } = await client.query(
        `SELECT d.id, d.venta_id, v.pedido_id, d.producto_id, d.nombre,
                d.precio_unitario, d.cantidad
         FROM public.venta_detalle d
         JOIN public.ventas v ON v.id = d.venta_id
         ORDER BY d.id`
    );
    for (const fila of detalles) {
        if (mapas.has(claveDe('venta_detalle', fila.id))) {
            continue;
        }
        const pedidoId = mapaRequerido(mapas, 'pedidos', fila.pedido_id);
        const productoId = mapaRequerido(mapas, 'productos', fila.producto_id);
        let detalle = await client.query(
            `SELECT id_detalle_pedido FROM detalle_pedido_venta
             WHERE pedido_id_pedido = $1 AND productos_idproducto = $2`,
            [pedidoId, productoId]
        );
        if (!detalle.rows[0]) {
            detalle = await client.query(
                `INSERT INTO detalle_pedido_venta (
                    pedido_id_pedido, productos_idproducto, nombre_producto,
                    precio_unitario, cantidad
                 )
                 VALUES ($1, $2, $3, $4, $5)
                 RETURNING id_detalle_pedido`,
                [pedidoId, productoId, fila.nombre, fila.precio_unitario, fila.cantidad]
            );
        }
        await guardarMapa(client, mapas, 'venta_detalle', fila.id, detalle.rows[0].id_detalle_pedido);
    }
}

async function migrarCodigosYAuditoria(client, mapas) {
    if (await tablaExiste(client, 'codigos_acceso')) {
        const { rows } = await client.query(
            `SELECT id, usuario_id, codigo, tipo, expira_en, usado
             FROM public.codigos_acceso
             ORDER BY id`
        );
        for (const fila of rows) {
            if (mapas.has(claveDe('codigos_acceso', fila.id))) {
                continue;
            }
            const usuarioId = mapaRequerido(mapas, 'usuarios', fila.usuario_id);
            const insertado = await client.query(
                `INSERT INTO codigos_acceso (usuario_id, codigo, tipo, expira_en, usado)
                 VALUES ($1, $2, $3, $4, $5)
                 RETURNING id`,
                [usuarioId, fila.codigo, fila.tipo, fila.expira_en, fila.usado]
            );
            await guardarMapa(client, mapas, 'codigos_acceso', fila.id, insertado.rows[0].id);
        }
    }

    if (await tablaExiste(client, 'auditoria')) {
        const { rows } = await client.query(
            `SELECT id, usuario_id, accion, detalle, creado_en
             FROM public.auditoria
             ORDER BY id`
        );
        for (const fila of rows) {
            if (mapas.has(claveDe('auditoria', fila.id))) {
                continue;
            }
            const usuarioId = fila.usuario_id === null
                ? null
                : mapas.get(claveDe('usuarios', fila.usuario_id)) || null;
            const insertado = await client.query(
                `INSERT INTO auditoria (usuario_id, accion, detalle, creado_en)
                 VALUES ($1, $2, $3, COALESCE($4, NOW()))
                 RETURNING id`,
                [usuarioId, fila.accion, fila.detalle, fila.creado_en]
            );
            await guardarMapa(client, mapas, 'auditoria', fila.id, insertado.rows[0].id);
        }
    }
}

async function migrarDatosPublicos(client) {
    if (!(await tablaExiste(client, 'usuarios'))) {
        return { migrada: false };
    }

    const mapas = await cargarMapas(client);
    await migrarRolesYPermisos(client, mapas);
    await migrarUsuarios(client, mapas);
    await migrarClientes(client, mapas);
    await migrarCategorias(client, mapas);
    await migrarProductos(client, mapas);
    await migrarProveedores(client, mapas);
    await migrarRelacionProveedorProducto(client, mapas);
    await migrarCompras(client, mapas);
    await migrarCarritos(client, mapas);
    await migrarPedidos(client, mapas);
    await migrarVentas(client, mapas);
    await migrarCodigosYAuditoria(client, mapas);

    return { migrada: true, registros: mapas.size };
}

module.exports = {
    migrarDatosPublicos
};
