const express = require('express');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const { pool } = require('../db/pool');
const verificarToken = require('../middleware/auth');
const exigirPermiso = require('../middleware/permiso');
const { httpError, dinero } = require('../utils/validar');

const router = express.Router();
router.use(verificarToken, exigirPermiso('reportes.exportar'));

function rangoFechas(query) {
    const hoy = new Date();
    const inicioMes = new Date(hoy.getFullYear(), hoy.getMonth(), 1).toISOString().slice(0, 10);
    const desde = query.desde || inicioMes;
    const hasta = query.hasta || hoy.toISOString().slice(0, 10);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(desde) || !/^\d{4}-\d{2}-\d{2}$/.test(hasta)) {
        throw httpError(400, 'Las fechas deben tener formato YYYY-MM-DD');
    }

    return { desde, hasta };
}

async function filasVentas(desde, hasta) {
    const { rows } = await pool.query(
        `SELECT v.id AS venta_id, v.fecha, v.estado, c.nombre AS cliente, c.documento,
                vd.nombre AS producto, vd.cantidad, vd.precio_unitario, vd.subtotal
         FROM api_sales v
         JOIN api_customers c ON c.id = v.cliente_id
         JOIN api_sale_items vd ON vd.venta_id = v.id
         WHERE v.fecha >= $1::date
           AND v.fecha < ($2::date + INTERVAL '1 day')
         ORDER BY v.fecha DESC, v.id DESC`,
        [desde, hasta]
    );

    return rows.map((fila) => ({
        ...fila,
        precio_unitario: dinero(fila.precio_unitario),
        subtotal: dinero(fila.subtotal)
    }));
}

router.get('/ventas', async (req, res, next) => {
    try {
        const { desde, hasta } = rangoFechas(req.query);
        const filas = await filasVentas(desde, hasta);
        const formato = (req.query.formato || 'json').toLowerCase();

        if (formato === 'json') {
            const total = dinero(filas.filter((fila) => fila.estado === 'activa').reduce((suma, fila) => suma + fila.subtotal, 0));
            return res.json({ desde, hasta, total, data: filas });
        }

        if (formato === 'xlsx') {
            const libro = new ExcelJS.Workbook();
            const hoja = libro.addWorksheet('Ventas');
            hoja.columns = [
                { header: 'Venta', key: 'venta_id', width: 10 },
                { header: 'Fecha', key: 'fecha', width: 22 },
                { header: 'Estado', key: 'estado', width: 12 },
                { header: 'Cliente', key: 'cliente', width: 28 },
                { header: 'Documento', key: 'documento', width: 16 },
                { header: 'Producto', key: 'producto', width: 28 },
                { header: 'Cantidad', key: 'cantidad', width: 12 },
                { header: 'Precio', key: 'precio_unitario', width: 12 },
                { header: 'Subtotal', key: 'subtotal', width: 14 }
            ];
            filas.forEach((fila) => hoja.addRow(fila));
            hoja.getRow(1).font = { bold: true };

            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename="ventas-${desde}-${hasta}.xlsx"`);
            await libro.xlsx.write(res);
            return res.end();
        }

        if (formato === 'pdf') {
            const doc = new PDFDocument({ margin: 40, size: 'A4' });
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="ventas-${desde}-${hasta}.pdf"`);
            doc.pipe(res);
            doc.fontSize(16).text('Lacombalpalo');
            doc.moveDown(0.3);
            doc.fontSize(12).text(`Reporte de ventas del ${desde} al ${hasta}`);
            doc.moveDown();

            if (filas.length === 0) {
                doc.fontSize(11).text('No hay ventas en ese rango.');
            }

            filas.forEach((fila) => {
                const fecha = new Date(fila.fecha).toISOString().slice(0, 16).replace('T', ' ');
                doc.fontSize(10).text(
                    `${fecha}  |  Venta ${fila.venta_id}  |  ${fila.estado}  |  ${fila.cliente} (${fila.documento})`
                );
                doc.text(`    ${fila.producto}  x${fila.cantidad}  $${fila.subtotal}`);
                doc.moveDown(0.4);
            });

            const total = dinero(filas.filter((fila) => fila.estado === 'activa').reduce((suma, fila) => suma + fila.subtotal, 0));
            doc.moveDown();
            doc.fontSize(12).text(`Total de ventas activas: $${total}`);
            doc.end();
            return;
        }

        throw httpError(400, 'El formato debe ser json, xlsx o pdf');
    } catch (error) {
        next(error);
    }
});

module.exports = router;
