const fetch = require('node-fetch'); // or just fetch if node 18+

async function test() {
  try {
    const res = await fetch('http://localhost:8000/api/v1/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const data = await res.json();
    console.log("Status:", res.status);
    console.log("Data:", data);
  } catch (err) {
    console.error("Error:", err);
  }
}
test();