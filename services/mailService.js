const axios = require('axios');

const sendMail = async (to, subject, html) => {
    if (!process.env.BREVO_API_KEY || !process.env.BREVO_SENDER_EMAIL) {
        const error = new Error('El envío de correo no está configurado. Define BREVO_API_KEY y BREVO_SENDER_EMAIL en .env');
        error.status = 503;
        throw error;
    }

    let response;

    try {
        response = await axios.post(
        'https://api.brevo.com/v3/smtp/email',
        {
            sender: {
                name: process.env.BREVO_SENDER_NAME || 'Lacombalpalo',
                email: process.env.BREVO_SENDER_EMAIL
            },
            to: [{ email: to }],
            subject,
            htmlContent: html
        },
        {
            headers: {
                accept: 'application/json',
                'api-key': process.env.BREVO_API_KEY,
                'content-type': 'application/json'
            }
        }
        );
    } catch (error) {
        const fallo = new Error('No se pudo enviar el correo');
        fallo.status = 502;
        throw fallo;
    }

    return response.data;
};

module.exports = {
    sendMail
};
