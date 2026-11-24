const express = require('express');
const cors = require('cors');
require('dotenv').config();

const { pool } = require('./db/pool');
const authRoutes = require('./routers/auth');
const usuariosRoutes = require('./routers/usuarios');
const rolesRoutes = require('./routers/roles');
const categoriasRoutes = require('./routers/categorias');
const productosRoutes = require('./routers/productos');
const proveedoresRoutes = require('./routers/proveedores');
const comprasRoutes = require('./routers/compras');
const clientesRoutes = require('./routers/clientes');
const carritoRoutes = require('./routers/carrito');
const pedidosRoutes = require('./routers/pedidos');
const ventasRoutes = require('./routers/ventas');
const dashboardRoutes = require('./routers/dashboard');
const reportesRoutes = require('./routers/reportes');
const auditoriaRoutes = require('./routers/auditoria');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
    res.json({
        nombre: 'Lacombalpalo',
        message: 'API de comercialización de productos artesanales'
    });
});

app.get('/api/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ ok: true, base: 'postgresql' });
    } catch (error) {
        res.status(500).json({ ok: false, message: 'Sin conexión a PostgreSQL' });
    }
});

app.use('/api/auth', authRoutes);
app.use('/api/usuarios', usuariosRoutes);
app.use('/api/roles', rolesRoutes.router);
app.use('/api/permisos', rolesRoutes.permisos);
app.use('/api/categorias', categoriasRoutes);
app.use('/api/productos', productosRoutes);
app.use('/api/proveedores', proveedoresRoutes);
app.use('/api/compras', comprasRoutes);
app.use('/api/clientes', clientesRoutes);
app.use('/api/carrito', carritoRoutes);
app.use('/api/pedidos', pedidosRoutes);
app.use('/api/ventas', ventasRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/reportes', reportesRoutes);
app.use('/api/auditoria', auditoriaRoutes);

app.use((req, res) => {
    res.status(404).json({ message: 'Ruta no encontrada' });
});

app.use((error, req, res, next) => {
    console.error(error);

    if (error.code === '23505') {
        return res.status(409).json({ message: 'Ya existe un registro con esos datos' });
    }

    if (error.code === '23503') {
        return res.status(400).json({ message: 'No se puede completar porque hay datos relacionados' });
    }

    if (error.code === '23514') {
        return res.status(400).json({ message: 'Hay un dato que no cumple las reglas del negocio' });
    }

    const status = error.status || 500;
    res.status(status).json({
        message: status === 500 ? 'Error interno del servidor' : error.message
    });
});

async function iniciar() {
    const { rows } = await pool.query(
        `SELECT to_regclass('lacombalpalo.usuario') AS usuario,
                to_regclass('lacombalpalo.api_users') AS usuarios_api`
    );

    if (!rows[0].usuario || !rows[0].usuarios_api) {
        throw new Error('La base no está inicializada. Ejecuta npm run db:init antes de iniciar la API.');
    }

    app.listen(port, () => {
        console.log(`Lacombalpalo escuchando en el puerto ${port}`);
    })
}

iniciar().catch((error) => {
    console.error('No se pudo iniciar la API');
    console.error(error.message);
    process.exit(1);
});
