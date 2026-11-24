const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { Client } = require('pg');
require('dotenv').config();
const { pool, withTransaction } = require('./pool');
const { migrarDatosPublicos } = require('./migratePublic');

const PERMISOS = [
    ['usuarios.ver', 'Ver usuarios del sistema'],
    ['usuarios.gestionar', 'Crear y editar usuarios'],
    ['roles.ver', 'Ver roles y permisos'],
    ['roles.gestionar', 'Administrar roles y su matriz de permisos'],
    ['auditoria.ver', 'Ver el registro de acciones'],
    ['categorias.ver', 'Ver categorías'],
    ['categorias.gestionar', 'Crear, editar y eliminar categorías'],
    ['productos.ver', 'Ver el catálogo'],
    ['productos.gestionar', 'Crear, editar y desactivar productos'],
    ['proveedores.ver', 'Ver proveedores'],
    ['proveedores.gestionar', 'Administrar proveedores y sus costos'],
    ['compras.ver', 'Ver compras'],
    ['compras.gestionar', 'Registrar y anular compras'],
    ['clientes.ver', 'Ver clientes'],
    ['clientes.gestionar', 'Registrar y editar clientes'],
    ['carrito.gestionar', 'Armar el carrito de compras'],
    ['pedidos.crear', 'Crear pedidos desde el carrito'],
    ['pedidos.ver', 'Ver todos los pedidos'],
    ['pedidos.gestionar', 'Aprobar, rechazar y entregar pedidos'],
    ['ventas.ver', 'Ver ventas'],
    ['ventas.anular', 'Anular ventas'],
    ['dashboard.ver', 'Ver métricas del negocio'],
    ['reportes.exportar', 'Exportar reportes a PDF o Excel']
];

const PERMISOS_OPERARIO = [
    'categorias.ver',
    'productos.ver',
    'productos.gestionar',
    'proveedores.ver',
    'proveedores.gestionar',
    'compras.ver',
    'compras.gestionar',
    'clientes.ver',
    'clientes.gestionar',
    'pedidos.ver',
    'pedidos.gestionar',
    'ventas.ver',
    'dashboard.ver',
    'reportes.exportar'
];

const PERMISOS_CLIENTE = [
    'categorias.ver',
    'productos.ver',
    'carrito.gestionar',
    'pedidos.crear'
];

const CATEGORIAS = [
    'Mesas rústicas',
    'Espejos',
    'Bancas',
    'Letreros',
    'Centros de mesa',
    'Tótems'
];

async function asegurarBaseDeDatos() {
    const cliente = new Client({ connectionString: process.env.DATABASE_URL });

    try {
        await cliente.connect();
        await cliente.end();
        return;
    } catch (error) {
        if (error.code !== '3D000') {
            throw error;
        }
    }

    const url = new URL(process.env.DATABASE_URL);
    const dbName = decodeURIComponent(url.pathname.replace(/^\//, ''));

    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(dbName)) {
        throw new Error('El nombre de la base de datos no es válido');
    }

    url.pathname = '/postgres';
    const admin = new Client({ connectionString: url.toString() });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
}

async function asignarPermisos(nombreRol, codigos) {
    const rol = await pool.query('SELECT id FROM roles WHERE name = $1', [nombreRol]);

    if (!rol.rows[0]) {
        return;
    }

    const existentes = await pool.query(
        'SELECT 1 FROM role_permissions WHERE role_id = $1 LIMIT 1',
        [rol.rows[0].id]
    );

    if (existentes.rows[0]) {
        return;
    }

    const privilegio = await pool.query(
        "SELECT id_privilegio FROM privilegios WHERE nombre_privilegio = 'permitir'"
    );

    if (!privilegio.rows[0]) {
        throw new Error('No se encontró el privilegio base para asignar permisos');
    }

    await pool.query(
        `INSERT INTO asignacion_rol (rol_id, permiso_id, privilegio_id)
         SELECT $1, id_permiso, $3 FROM permisos WHERE codigo = ANY($2::text[])
         ON CONFLICT DO NOTHING`,
        [rol.rows[0].id, codigos, privilegio.rows[0].id_privilegio]
    );
}

async function sembrar() {
    await pool.query(
        `INSERT INTO privilegios (nombre_privilegio, descripcion)
         VALUES ('permitir', 'Autoriza la acción indicada por el permiso')
         ON CONFLICT (nombre_privilegio) DO NOTHING`
    );

    for (const [codigo, descripcion] of PERMISOS) {
        await pool.query(
            `INSERT INTO permisos (nombre_permiso, codigo, descripcion)
             VALUES ($1, $1, $2)
             ON CONFLICT (codigo) DO NOTHING`,
            [codigo, descripcion]
        );
    }

    await pool.query(
        `INSERT INTO roles (name, description, is_system) VALUES
            ('administrador', 'Acceso total a la operación y a la seguridad', TRUE),
            ('operario', 'Taller y operación comercial diaria', TRUE),
            ('cliente', 'Compra en el catálogo y hace pedidos', TRUE)
         ON CONFLICT (name) DO NOTHING`
    );

    await pool.query(
        `UPDATE roles SET is_system = TRUE
         WHERE name = ANY($1::text[]) AND is_system = FALSE`,
        [['administrador', 'operario', 'cliente']]
    );

    const privilegio = await pool.query(
        "SELECT id_privilegio FROM privilegios WHERE nombre_privilegio = 'permitir'"
    );

    await pool.query(
        `INSERT INTO asignacion_rol (rol_id, permiso_id, privilegio_id)
         SELECT r.id, p.id_permiso, $1
         FROM roles r
         CROSS JOIN permisos p
         WHERE r.name = 'administrador'
         ON CONFLICT DO NOTHING`,
        [privilegio.rows[0].id_privilegio]
    );

    await asignarPermisos('operario', PERMISOS_OPERARIO);
    await asignarPermisos('cliente', PERMISOS_CLIENTE);

    for (const nombre of CATEGORIAS) {
        await pool.query(
            `INSERT INTO categoria_producto (nombre_categoria)
             VALUES ($1)
             ON CONFLICT (nombre_categoria) DO NOTHING`,
            [nombre]
        );
    }
}

async function asegurarAdministrador() {
    const existe = await pool.query(
        'SELECT 1 FROM usuario WHERE LOWER(correo) = LOWER($1)',
        ['admin@lacombalpalo.com']
    );

    if (existe.rows[0]) {
        return;
    }

    const passwordHash = await bcrypt.hash('Admin123*', 10);
    await pool.query(
        `INSERT INTO usuario (nombre_completo, correo, telefono, clave_hash, roles_idroles)
         SELECT 'Administrador', 'admin@lacombalpalo.com', '3012021297', $1, id
         FROM roles
         WHERE name = 'administrador'
         ON CONFLICT DO NOTHING`,
        [passwordHash]
    );
}

async function inicializar() {
    await asegurarBaseDeDatos();
    const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await pool.query(sql);
    await sembrar();
    const migracion = await withTransaction(migrarDatosPublicos);
    await asegurarAdministrador();
    if (migracion.migrada) {
        console.log(`Datos públicos migrados a lacombalpalo (${migracion.registros} referencias).`);
    }
    console.log('Base de datos de Lacombalpalo lista');
}

if (require.main === module) {
    inicializar()
        .catch((error) => {
            console.error('No se pudo preparar la base de datos');
            console.error(error.message);
            process.exitCode = 1;
        })
        .finally(async () => {
            await pool.end();
        });
}

module.exports = {
    inicializar
};
