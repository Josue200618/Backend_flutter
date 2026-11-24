const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool, withTransaction } = require('../db/pool');
const keys = require('../settings/keys');
const { sendMail } = require('../services/mailService');
const verificarToken = require('../middleware/auth');
const { registrarAuditoria } = require('../utils/auditoria');
const {
    httpError,
    requeridos,
    normalizarCorreo
} = require('../utils/validar');

const router = express.Router();

function codigoAleatorio() {
    return String(Math.floor(100000 + Math.random() * 900000));
}

function tokenDe(usuario) {
    return jwt.sign(
        {
            id: usuario.id,
            correo: usuario.correo,
            rol_id: usuario.rol_id,
            rol: usuario.rol
        },
        keys.key,
        { expiresIn: '7d' }
    );
}

router.post('/registro', async (req, res, next) => {
    try {
        requeridos(req.body, ['nombre', 'correo', 'telefono', 'password', 'confirmPassword', 'documento', 'direccion']);

        const password = String(req.body.password);
        if (password.length < 8) {
            throw httpError(400, 'La contraseña debe tener al menos 8 caracteres');
        }

        if (password !== req.body.confirmPassword) {
            throw httpError(400, 'Las contraseñas no coinciden');
        }

        const tipo = req.body.tipo || 'persona';
        if (!['persona', 'empresa'].includes(tipo)) {
            throw httpError(400, 'El tipo de cliente debe ser persona o empresa');
        }

        if (tipo === 'empresa' && !req.body.razon_social) {
            throw httpError(400, 'La razón social es obligatoria para una empresa');
        }

        const correo = normalizarCorreo(req.body.correo);
        const passwordHash = await bcrypt.hash(password, 10);

        const usuario = await withTransaction(async (client) => {
            const rol = await client.query("SELECT id FROM api_roles WHERE nombre = 'cliente'");
            if (!rol.rows[0]) {
                throw httpError(500, 'Falta el rol cliente. Ejecuta la inicialización de la base');
            }

            const creado = await client.query(
                `INSERT INTO api_users (nombre, correo, telefono, password_hash, rol_id)
                 VALUES ($1, $2, $3, $4, $5)
                 RETURNING id, nombre, correo, telefono, rol_id`,
                [req.body.nombre.trim(), correo, String(req.body.telefono).trim(), passwordHash, rol.rows[0].id]
            );

            await client.query(
                `INSERT INTO api_customers (tipo, nombre, razon_social, documento, telefono, correo, direccion, usuario_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [
                    tipo,
                    req.body.nombre.trim(),
                    req.body.razon_social || null,
                    String(req.body.documento).trim(),
                    String(req.body.telefono).trim(),
                    correo,
                    req.body.direccion.trim(),
                    creado.rows[0].id
                ]
            );

            await registrarAuditoria(creado.rows[0].id, 'registro_cliente', { correo }, client);
            return { ...creado.rows[0], rol: 'cliente' };
        });

        res.status(201).json({
            message: 'Cuenta creada correctamente',
            token: tokenDe(usuario),
            usuario: {
                id: usuario.id,
                nombre: usuario.nombre,
                correo: usuario.correo,
                telefono: usuario.telefono,
                rol: usuario.rol
            }
        });
    } catch (error) {
        next(error);
    }
});

router.post('/login', async (req, res, next) => {
    try {
        requeridos(req.body, ['correo', 'password']);
        const correo = normalizarCorreo(req.body.correo);

        const { rows } = await pool.query(
            `SELECT u.*, r.nombre AS rol
             FROM api_users u
             JOIN api_roles r ON r.id = u.rol_id
             WHERE u.correo = $1`,
            [correo]
        );

        const usuario = rows[0];
        if (!usuario || !usuario.activo) {
            throw httpError(400, 'Correo o contraseña incorrectos');
        }

        if (usuario.bloqueado_hasta && new Date(usuario.bloqueado_hasta) > new Date()) {
            throw httpError(423, 'La cuenta está bloqueada temporalmente por intentos fallidos. Espera 15 minutos.');
        }

        const coincide = await bcrypt.compare(String(req.body.password), usuario.password_hash);
        if (!coincide) {
            await pool.query(
                `UPDATE api_users
                 SET intentos_fallidos = CASE WHEN intentos_fallidos + 1 >= 5 THEN 0 ELSE intentos_fallidos + 1 END,
                     bloqueado_hasta = CASE WHEN intentos_fallidos + 1 >= 5 THEN NOW() + INTERVAL '15 minutes' ELSE NULL END
                 WHERE id = $1`,
                [usuario.id]
            );
            await registrarAuditoria(usuario.id, 'login_fallido', { correo });
            throw httpError(400, 'Correo o contraseña incorrectos');
        }

        await pool.query(
            'UPDATE api_users SET intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = $1',
            [usuario.id]
        );
        await registrarAuditoria(usuario.id, 'login', { correo });

        res.json({
            message: 'Inicio de sesión exitoso',
            token: tokenDe(usuario),
            usuario: {
                id: usuario.id,
                nombre: usuario.nombre,
                correo: usuario.correo,
                telefono: usuario.telefono,
                rol: usuario.rol
            }
        });
    } catch (error) {
        next(error);
    }
});

router.get('/perfil', verificarToken, (req, res) => {
    res.json({ usuario: req.usuario });
});

router.post('/logout', verificarToken, async (req, res, next) => {
    try {
        await registrarAuditoria(req.usuario.id, 'logout', null);
        res.json({ message: 'Sesión cerrada. Elimina el token en el cliente.' });
    } catch (error) {
        next(error);
    }
});

router.post('/forgot-password', async (req, res, next) => {
    try {
        requeridos(req.body, ['correo']);
        const correo = normalizarCorreo(req.body.correo);
        const { rows } = await pool.query('SELECT id, nombre, correo FROM api_users WHERE correo = $1 AND activo = TRUE', [correo]);

        if (!rows[0]) {
            throw httpError(404, 'Usuario no encontrado');
        }

        const codigo = codigoAleatorio();
        const expiraEn = new Date(Date.now() + 15 * 60 * 1000);

        await pool.query(
            `UPDATE codigos_acceso SET usado = TRUE
             WHERE usuario_id = $1 AND tipo = 'reset' AND usado = FALSE`,
            [rows[0].id]
        );

        await pool.query(
            `INSERT INTO codigos_acceso (usuario_id, codigo, tipo, expira_en)
             VALUES ($1, $2, 'reset', $3)`,
            [rows[0].id, codigo, expiraEn]
        );

        await sendMail(
            rows[0].correo,
            'Recuperación de contraseña Lacombalpalo',
            `<div style="font-family:Arial;padding:24px">
                <h2>Hola ${rows[0].nombre}</h2>
                <p>Tu código para restablecer la contraseña es:</p>
                <h1 style="letter-spacing:6px">${codigo}</h1>
                <p>Expira en 15 minutos. Si no solicitaste el cambio, ignora este correo.</p>
            </div>`
        );

        res.json({ message: 'Se envió el código de recuperación al correo.' });
    } catch (error) {
        next(error);
    }
});

router.post('/reset-password', async (req, res, next) => {
    try {
        requeridos(req.body, ['correo', 'codigo', 'password', 'confirmPassword']);

        if (String(req.body.password).length < 8) {
            throw httpError(400, 'La contraseña debe tener al menos 8 caracteres');
        }

        if (req.body.password !== req.body.confirmPassword) {
            throw httpError(400, 'Las contraseñas no coinciden');
        }

        const correo = normalizarCorreo(req.body.correo);
        const { rows } = await pool.query('SELECT id FROM api_users WHERE correo = $1', [correo]);
        if (!rows[0]) {
            throw httpError(404, 'Usuario no encontrado');
        }

        const codigo = await pool.query(
            `SELECT id, expira_en
             FROM codigos_acceso
             WHERE usuario_id = $1 AND codigo = $2 AND tipo = 'reset' AND usado = FALSE
             ORDER BY id DESC
             LIMIT 1`,
            [rows[0].id, String(req.body.codigo).trim()]
        );

        if (!codigo.rows[0]) {
            throw httpError(400, 'Código inválido');
        }

        if (new Date() > new Date(codigo.rows[0].expira_en)) {
            throw httpError(400, 'El código ha expirado');
        }

        const passwordHash = await bcrypt.hash(String(req.body.password), 10);
        await pool.query('UPDATE api_users SET password_hash = $1, intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = $2', [
            passwordHash,
            rows[0].id
        ]);
        await pool.query('UPDATE codigos_acceso SET usado = TRUE WHERE id = $1', [codigo.rows[0].id]);
        await registrarAuditoria(rows[0].id, 'reset_password', null);

        res.json({ message: 'Contraseña actualizada correctamente' });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
