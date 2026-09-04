const { Client } = require('pg');
const client = new Client({ connectionString: 'postgresql://postgres:postgres@localhost:5432/redrivo' });

async function run() {
    await client.connect();
    const res = await client.query("DELETE FROM service_requests WHERE id LIKE 'test_%' OR id LIKE 'req_real_%' RETURNING id");
    console.log('Deleted rows:', res.rows.length);
    await client.end();
}
run().catch(console.error);
