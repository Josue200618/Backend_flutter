const express = require('express');
const { pool, withTransaction } = require('../db/pool');
const verificarToken = require('../middleware/auth');
const exigirPermiso = require('../middleware/permiso');
const { registrarAuditoria } = require('../utils/auditoria');
const { httpError, requeridos, exigirId } = require('../utils/validar');

const router = express.Router();
const permisos = express.Router();

async function permisosDeRol(rolId) {
    const { rows } = await pool.query(
        `SELECT p.id, p.code AS codigo, p.description AS descripcion
         FROM permissions p
         JOIN role_permissions rp ON rp.permission_id = p.id
         WHERE rp.role_id = $1
         ORDER BY p.code`,
        [rolId]
    );
    return rows;
}

async function insertarPermisos(client, rolId, codigos) {
    if (codigos.length === 0) {
        return;
    }

    const privilegio = await client.query(
        "SELECT id_privilegio FROM privilegios WHERE nombre_privilegio = 'permitir'"
    );

    if (!privilegio.rows[0]) {
        throw httpError(500, 'No está configurado el privilegio base para asignar permisos');
    }

    await client.query(
        `INSERT INTO asignacion_rol (rol_id, permiso_id, privilegio_id)
         SELECT $1, id_permiso, $3 FROM permisos WHERE codigo = ANY($2::text[])
         ON CONFLICT DO NOTHING`,
        [rolId, codigos, privilegio.rows[0].id_privilegio]
    );
}

router.use(verificarToken);
permisos.use(verificarToken);

permisos.get('/', exigirPermiso('roles.ver'), async (req, res, next) => {
    try {
        const { rows } = await pool.query('SELECT id, code AS codigo, description AS descripcion FROM permissions ORDER BY code');
        res.json({ data: rows });
    } catch (error) {
        next(error);
    }
});

router.get('/', exigirPermiso('roles.ver'), async (req, res, next) => {
    try {
        const { rows } = await pool.query('SELECT id, nombre, descripcion, es_sistema FROM api_roles ORDER BY id');
        const data = [];

        for (const rol of rows) {
            data.push({ ...rol, permisos: await permisosDeRol(rol.id) });
        }

        res.json({ data });
    } catch (error) {
        next(error);
    }
});

router.post('/', exigirPermiso('roles.gestionar'), async (req, res, next) => {
    try {
        requeridos(req.body, ['nombre']);
        const codigos = Array.isArray(req.body.permisos) ? req.body.permisos : [];

        const rol = await withTransaction(async (client) => {
            const creado = await client.query(
                `INSERT INTO api_roles (nombre, descripcion)
                 VALUES ($1, $2)
                 RETURNING id, nombre, descripcion, es_sistema`,
                [req.body.nombre.trim(), req.body.descripcion || '']
            );

            await insertarPermisos(client, creado.rows[0].id, codigos);

            return creado.rows[0];
        });

        await registrarAuditoria(req.usuario.id, 'rol_creado', { rolId: rol.id, nombre: rol.nombre });
        res.status(201).json({ message: 'Rol creado', rol: { ...rol, permisos: await permisosDeRol(rol.id) } });
    } catch (error) {
        next(error);
    }
});

router.put('/:id', exigirPermiso('roles.gestionar'), async (req, res, next) => {
    try {
        exigirId(req.params.id);
        const actual = await pool.query('SELECT id, nombre, es_sistema FROM api_roles WHERE id = $1', [req.params.id]);

        if (!actual.rows[0]) {
            throw httpError(404, 'Rol no encontrado');
        }

        if (actual.rows[0].es_sistema && req.body.nombre && req.body.nombre !== actual.rows[0].nombre) {
            throw httpError(400, 'No se puede renombrar un rol del sistema');
        }

        if (actual.rows[0].nombre === 'administrador' && req.body.permisos) {
            throw httpError(400, 'El rol administrador conserva todos los permisos');
        }

        await withTransaction(async (client) => {
            await client.query(
                `UPDATE api_roles
                 SET nombre = COALESCE($1, nombre),
                     descripcion = COALESCE($2, descripcion)
                 WHERE id = $3`,
                [req.body.nombre || null, req.body.descripcion || null, req.params.id]
            );

            if (Array.isArray(req.body.permisos)) {
                await client.query('DELETE FROM asignacion_rol WHERE rol_id = $1', [req.params.id]);
                await insertarPermisos(client, req.params.id, req.body.permisos);
            }
        });

        await registrarAuditoria(req.usuario.id, 'rol_actualizado', { rolId: Number(req.params.id) });
        const rol = await pool.query('SELECT id, nombre, descripcion, es_sistema FROM api_roles WHERE id = $1', [req.params.id]);
        res.json({ message: 'Rol actualizado', rol: { ...rol.rows[0], permisos: await permisosDeRol(req.params.id) } });
    } catch (error) {
        next(error);
    }
});

router.delete('/:id', exigirPermiso('roles.gestionar'), async (req, res, next) => {
    try {
        exigirId(req.params.id);
        const actual = await pool.query('SELECT id, nombre, es_sistema FROM api_roles WHERE id = $1', [req.params.id]);

        if (!actual.rows[0]) {
            throw httpError(404, 'Rol no encontrado');
        }

        if (actual.rows[0].es_sistema) {
            throw httpError(400, 'No se puede eliminar un rol del sistema');
        }

        const usados = await pool.query('SELECT 1 FROM api_users WHERE rol_id = $1 LIMIT 1', [req.params.id]);
        if (usados.rows[0]) {
            throw httpError(409, 'Hay usuarios con este rol. Reasígnalos antes de eliminarlo');
        }

        await pool.query('DELETE FROM api_roles WHERE id = $1', [req.params.id]);
        await registrarAuditoria(req.usuario.id, 'rol_eliminado', { rolId: Number(req.params.id) });
        res.json({ message: 'Rol eliminado' });
    } catch (error) {
        next(error);
    }
});

module.exports = {
    router,
    permisos
};
