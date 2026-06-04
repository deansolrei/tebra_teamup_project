import { getProviders } from './src/clients/tebraClient.js';

async function main() {
    try {
        const result = await getProviders();
        console.log('\n===== PARSED RESPONSE =====\n');
        console.log(JSON.stringify(result, null, 2));
    } catch (err) {
        console.log('\n===== PROBE FAILED =====\n');
        console.log(err.message);
        if (err.response?.data) {
            console.log('\n--- Raw error body from server ---\n');
            console.log(err.response.data);
        }
    }
}

main();