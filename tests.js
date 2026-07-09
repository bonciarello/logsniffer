/**
 * Test suite for LogSniffer stack-trace parser.
 * Run with: node tests.js
 */

const { parseStackTrace, detectLanguage, extractExceptionLine } = require('./server.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'assertEq'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

console.log('\nLogSniffer — Test Suite\n');

// ── Java ──
console.log('Java stack traces:');
const javaInput = `java.lang.NullPointerException: Cannot invoke "String.length()" because "value" is null
    at com.acme.order.OrderService.calculateTotal(OrderService.java:142)
    at com.acme.order.OrderController.processOrder(OrderController.java:88)
    at com.acme.order.OrderController.handleRequest(OrderController.java:53)
    at com.acme.web.DispatcherServlet.doDispatch(DispatcherServlet.java:210)
    at com.acme.web.DispatcherServlet.service(DispatcherServlet.java:156)
Caused by: java.lang.IllegalStateException: Invalid order state
    at com.acme.order.OrderValidator.validate(OrderValidator.java:67)
    at com.acme.order.OrderService.calculateTotal(OrderService.java:138)`;

test('detects Java', () => {
  assertEq(detectLanguage(javaInput), 'java');
});

test('extracts exception line', () => {
  const ex = extractExceptionLine(javaInput);
  assert(ex.startsWith('java.lang.NullPointerException'), 'Should extract exception header');
});

test('parses at least 3 Java frames with file and line', () => {
  const frames = parseStackTrace(javaInput).filter(f => f.kind !== 'cause' && f.file && f.line);
  assert(frames.length >= 3, `Expected >= 3, got ${frames.length}`);
});

test('Java frame has correct file and line', () => {
  const frames = parseStackTrace(javaInput);
  const first = frames.find(f => f.fn && f.fn.includes('OrderService.calculateTotal') && f.line === 142);
  assert(first, 'Should find OrderService.calculateTotal at line 142');
  assertEq(first.file, 'OrderService.java');
});

test('Java frame order is root-cause first', () => {
  const frames = parseStackTrace(javaInput).filter(f => f.kind !== 'cause' && f.line);
  // First frame should be deepest (DispatcherServlet.service)
  assert(frames[0].fn.includes('OrderService.calculateTotal'), 'First frame should be the one listed first (deepest)');
  // The Java trace lists from point of failure downward, so first line = deepest call
});

test('Java "Caused by" is detected as cause knot', () => {
  const frames = parseStackTrace(javaInput);
  const cause = frames.find(f => f.kind === 'cause');
  assert(cause, 'Should have a cause knot');
  assert(cause.raw.includes('Caused by'), 'Cause knot should contain "Caused by"');
});

test('Java frames after caused by also parsed', () => {
  const frames = parseStackTrace(javaInput);
  const validator = frames.find(f => f.fn && f.fn.includes('OrderValidator.validate'));
  assert(validator, 'Should parse frames after Caused by');
  assertEq(validator.line, 67);
});

// ── Python ──
console.log('\nPython stack traces:');
const pythonInput = `Traceback (most recent call last):
  File "/app/api/handlers/orders.py", line 89, in post_order
    order = order_service.create(data)
  File "/app/services/order_service.py", line 142, in create
    self._validate_inventory(items)
  File "/app/services/order_service.py", line 210, in _validate_inventory
    stock = inventory_repo.get_stock(item.sku)
  File "/app/repositories/inventory_repo.py", line 56, in get_stock
    row = self.db.execute(query, [sku]).fetchone()
  File "/app/db/connection.py", line 33, in execute
    cursor = self._get_cursor()
  File "/app/db/connection.py", line 18, in _get_cursor
    raise DatabaseError("Connection pool exhausted")
app.errors.DatabaseError: Connection pool exhausted`;

test('detects Python', () => {
  assertEq(detectLanguage(pythonInput), 'python');
});

test('parses Python frames', () => {
  const frames = parseStackTrace(pythonInput);
  assert(frames.length >= 4, `Expected >= 4 Python frames, got ${frames.length}`);
});

test('Python frame has function, file, line', () => {
  const frames = parseStackTrace(pythonInput);
  const f = frames.find(fr => fr.fn === 'post_order');
  assert(f, 'Should find post_order frame');
  assertEq(f.file, '/app/api/handlers/orders.py');
  assertEq(f.line, 89);
});

test('Python frames in correct order (deepest first, most recent last)', () => {
  const frames = parseStackTrace(pythonInput);
  // Python traceback lists from most recent (root) to deepest — our parser preserves raw order
  // The first Python line is the entry point, last is deepest
  assertEq(frames[0].fn, 'post_order', 'First frame should be post_order (root call)');
  assertEq(frames[frames.length - 1].fn, '_get_cursor', 'Last frame should be deepest');
});

// ── JavaScript ──
console.log('\nJavaScript stack traces:');
const jsInput = `TypeError: Cannot read properties of null (reading 'address')
    at formatAddress (/app/services/userFormatter.js:47:22)
    at formatUser (/app/services/userFormatter.js:23:12)
    at processBatch (/app/handlers/userHandler.js:88:18)
    at async handleRequest (/app/handlers/userHandler.js:42:5)
    at async /app/middleware/router.js:15:3`;

test('detects JavaScript', () => {
  assertEq(detectLanguage(jsInput), 'javascript');
});

test('parses JS V8 frames', () => {
  const frames = parseStackTrace(jsInput);
  assert(frames.length >= 4, `Expected >= 4 JS frames, got ${frames.length}`);
});

test('JS frame has function, file, line, col', () => {
  const frames = parseStackTrace(jsInput);
  const f = frames.find(fr => fr.fn === 'formatAddress');
  assert(f, 'Should find formatAddress');
  assertEq(f.file, '/app/services/userFormatter.js');
  assertEq(f.line, 47);
  assertEq(f.col, 22);
});

test('JS anonymous function handled', () => {
  const frames = parseStackTrace(jsInput);
  const anon = frames.find(fr => fr.fn === '<anonymous>');
  assert(anon, 'Should have anonymous frame');
  assertEq(anon.line, 15);
});

test('JS frames in order from deepest to most recent', () => {
  const frames = parseStackTrace(jsInput);
  assertEq(frames[0].fn, 'formatAddress', 'First frame should be formatAddress (deepest)');
  // JS V8 traces: first line = point of error = deepest call
});

// ── JavaScript browser (Firefox) ──
console.log('\nJavaScript browser stack traces:');
const jsFfInput = `formatAddress@http://example.com/app/userFormatter.js:47:22
formatUser@http://example.com/app/userFormatter.js:23:12
processBatch@http://example.com/app/handler.js:88:18
@http://example.com/app/handler.js:5:3`;

test('parses Firefox-style JS frames', () => {
  const frames = parseStackTrace(jsFfInput);
  assert(frames.length >= 3, `Expected >= 3 FF frames, got ${frames.length}`);
});

test('Firefox anonymous (@) handled', () => {
  const frames = parseStackTrace(jsFfInput);
  const anon = frames.find(fr => fr.fn === '<anonymous>');
  assert(anon, 'Should detect anonymous call');
  assertEq(anon.line, 5);
});

// ── .NET ──
console.log('\n.NET stack traces:');
const dotnetInput = `System.ArgumentNullException: Value cannot be null. (Parameter 'customer')
   at MyShop.Services.OrderService.ValidateCustomer(Customer customer) in D:\\src\\MyShop\\Services\\OrderService.cs:line 245
   at MyShop.Services.OrderService.PlaceOrder(OrderRequest request) in D:\\src\\MyShop\\Services\\OrderService.cs:line 142
   at MyShop.Controllers.OrdersController.Create(OrderRequest request) in D:\\src\\MyShop\\Controllers\\OrdersController.cs:line 67`;

test('detects .NET', () => {
  assertEq(detectLanguage(dotnetInput), 'dotnet');
});

test('parses .NET frames', () => {
  const frames = parseStackTrace(dotnetInput);
  assert(frames.length >= 3, `Expected >= 3 .NET frames, got ${frames.length}`);
});

test('.NET frame has function, file, line', () => {
  const frames = parseStackTrace(dotnetInput);
  const f = frames.find(fr => fr.fn && fr.fn.includes('ValidateCustomer'));
  assert(f, 'Should find ValidateCustomer');
  assert(f.file.includes('OrderService.cs'), `File should contain OrderService.cs, got ${f.file}`);
  assertEq(f.line, 245);
});

test('.NET function signature preserved', () => {
  const frames = parseStackTrace(dotnetInput);
  assert(frames[0].fn.includes('ValidateCustomer(Customer customer)'), 'Should preserve parameter types');
});

// ── Edge cases ──
console.log('\nEdge cases:');

test('empty input returns empty array', () => {
  const frames = parseStackTrace('');
  assertEq(frames.length, 0);
});

test('null input returns empty array', () => {
  const frames = parseStackTrace(null);
  assertEq(frames.length, 0);
});

test('undefined input returns empty array', () => {
  const frames = parseStackTrace(undefined);
  assertEq(frames.length, 0);
});

test('non-stack-trace text returns empty', () => {
  const frames = parseStackTrace('Just some random log line\nAnother line');
  assertEq(frames.length, 0);
});

// ── Acceptance criteria ──
console.log('\n── Acceptance criteria ──');

test('AC1: Java input extracts >= 3 calls with correct file and line', () => {
  const frames = parseStackTrace(javaInput).filter(f => f.kind !== 'cause' && f.file && f.line);
  assert(frames.length >= 3, `Expected >= 3 frames with file and line, got ${frames.length}`);
  // Verify correctness
  assert(frames.some(f => f.file === 'OrderService.java' && f.line === 142), 'Missing OrderService.java:142');
  assert(frames.some(f => f.file === 'OrderController.java' && f.line === 88), 'Missing OrderController.java:88');
  assert(frames.some(f => f.file === 'OrderController.java' && f.line === 53), 'Missing OrderController.java:53');
});

test('AC2: JavaScript error displays calls in correct order (deepest first)', () => {
  const frames = parseStackTrace(jsInput);
  assert(frames.length >= 3, 'Should have at least 3 frames');
  // Deepest (point of error) is first
  assertEq(frames[0].fn, 'formatAddress', 'Deepest frame (formatAddress) should be first');
  // Most recent (entry point) is last
  const last = frames[frames.length - 1];
  assert(last.fn === '<anonymous>' || last.file.includes('router.js'), 'Last frame should be entry point');
});

// ── Summary ──
console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log(`${'─'.repeat(40)}\n`);

process.exit(failed > 0 ? 1 : 0);
