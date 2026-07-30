# Python async/await example

import asyncio
from typing import List, Optional

async def fetch_data(url: str) -> dict:
    await asyncio.sleep(0.1)
    return {"url": url, "data": "sample"}

async def process_items(items: List[str]) -> List[dict]:
    tasks = [fetch_data(item) for item in items]
    results = await asyncio.gather(*tasks)
    return results

async def main():
    urls = ["http://example.com/1", "http://example.com/2", "http://example.com/3"]
    results = await process_items(urls)
    for result in results:
        print(result)

if __name__ == "__main__":
    asyncio.run(main())
