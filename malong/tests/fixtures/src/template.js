const greeting = `Hello, ${name}!`
const nested = `Value: ${obj.map(x => x.id).join(',')}`

function render(items) {
  return items.map(item => `<li>${item}</li>`)
}
