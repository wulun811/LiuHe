import asyncio
from typing import Coroutine

async def fetch_data(url: str) -> dict:
    await asyncio.sleep(0.1)
    return {"url": url, "data": "..."}

async def process_all(urls: list[str]) -> list[dict]:
    tasks = [fetch_data(u) for u in urls]
    return await asyncio.gather(*tasks)

def main():
    urls = ["https://example.com", "https://test.org"]
    result = asyncio.run(process_all(urls))
    print(result)
