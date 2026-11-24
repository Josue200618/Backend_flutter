function httpError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
}

function requeridos(body, campos) {
    const faltantes = campos.filter((campo) => {
        const valor = body[campo];
        return valor === undefined || valor === null || String(valor).trim() === '';
    });

    if (faltantes.length > 0) {
        throw httpError(400, `Faltan campos obligatorios: ${faltantes.join(', ')}`);
    }
}

function idValido(id) {
    return /^[0-9]+$/.test(String(id));
}

function exigirId(id) {
    if (!idValido(id)) {
        throw httpError(400, 'El identificador no es válido');
    }
}

function paginacion(query) {
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 10, 1), 100);
    return {
        page,
        limit,
        offset: (page - 1) * limit
    };
}

function dinero(valor) {
    return Math.round(Number(valor) * 100) / 100;
}

function enteroPositivo(valor, etiqueta) {
    const numero = Number(valor);
    if (!Number.isInteger(numero) || numero <= 0) {
        throw httpError(400, `${etiqueta} debe ser un entero mayor que cero`);
    }
    return numero;
}

function enteroNoNegativo(valor, etiqueta) {
    const numero = Number(valor);
    if (valor === null || valor === undefined || String(valor).trim() === '' ||
        !Number.isInteger(numero) || numero < 0) {
        throw httpError(400, `${etiqueta} debe ser un entero mayor o igual que cero`);
    }
    return numero;
}

function normalizarCorreo(correo) {
    return String(correo || '').trim().toLowerCase();
}

module.exports = {
    httpError,
    requeridos,
    exigirId,
    paginacion,
    dinero,
    enteroPositivo,
    enteroNoNegativo,
    normalizarCorreo
};
