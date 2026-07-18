import httpx
import asyncio
import json

async def main():
    async with httpx.AsyncClient() as client:
        try:
            print("Sending POST request to /api/v1/sessions...")
            resp = await client.post('http://localhost:8000/api/v1/sessions', json={})
            print("Status:", resp.status_code)
            print("Body:", json.dumps(resp.json(), indent=2))
        except Exception as e:
            print("Error:", e)

asyncio.run(main())