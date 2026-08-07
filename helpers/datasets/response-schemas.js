const RESPONSE_ENTRY_PROPERTIES = {
    id: { type: 'integer' },
    kata: { type: 'string' },
    lema: { type: 'string', nullable: false },
    pelafalan: { type: 'string', nullable: false },
    etimologi: { type: 'string', nullable: true },
    makna: { type: 'string', nullable: false },
    tags_kelas: { type: 'string', nullable: true },
    tags_bahasa: { type: 'string', nullable: true },
    tags_bidang: { type: 'string', nullable: true },
    tags_ragam: { type: 'string', nullable: true },
    tags_sumber: { type: 'string', nullable: false },
    contoh: { type: 'string', nullable: true },
    turunan: { type: 'string', nullable: true },
    gabungan_kata: { type: 'string', nullable: true },
    peribahasa: { type: 'string', nullable: true },
    kiasan: { type: 'string', nullable: true },
    varian: { type: 'string', nullable: true },
    dasar: { type: 'string', nullable: true },
    jenis_entri: {
        type: 'string',
        enum: ['kata', 'frasa', 'peribahasa', 'lainnya'],
        nullable: false,
    },
};

const ENRICHER_RESPONSE_SCHEMA = {
    type: 'object',
    properties: {
        entries: {
            type: 'array',
            items: {
                type: 'object',
                properties: RESPONSE_ENTRY_PROPERTIES,
                required: [
                    'id',
                    'kata',
                    'lema',
                    'pelafalan',
                    'makna',
                    'jenis_entri',
                ],
            },
        },
    },
    required: ['entries'],
};

const GEMINI_RESPONSE_SCHEMA = ENRICHER_RESPONSE_SCHEMA;

module.exports = {
    ENRICHER_RESPONSE_SCHEMA,
    GEMINI_RESPONSE_SCHEMA,
};