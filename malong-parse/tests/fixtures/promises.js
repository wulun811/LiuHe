// JavaScript promises example

async function fetchData(url) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      resolve({ url, data: 'sample' });
    }, 100);
  });
}

async function processItems(items) {
  const promises = items.map(item => fetchData(item));
  const results = await Promise.all(promises);
  return results;
}

function createPromise(value) {
  return Promise.resolve(value);
}

function handleError() {
  return Promise.reject(new Error('test error'));
}

async function main() {
  const urls = ['http://example.com/1', 'http://example.com/2'];
  const results = await processItems(urls);
  console.log(results);
}

main().catch(console.error);
