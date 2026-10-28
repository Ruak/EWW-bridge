/* 补丁语义单测：node test/parser.js */
const assert = require('assert');
const { applyPatch, isRequestAborted } = require('../out/session/parser.js');

const state = {
  requests: [
    { requestId: 'r0', message: { text: 'q0' }, response: [] },
  ],
  pendingRequests: [{ id: 'p0' }, { id: 'p1' }],
};

// 1) 追加请求（无 i）
applyPatch(state, { kind: 2, k: ['requests'], v: [{ requestId: 'r1', message: { text: 'q1' }, response: [] }] });
assert.strictEqual(state.requests.length, 2);
assert.strictEqual(state.requests[1].requestId, 'r1');

// 2) 响应数组带索引插入（i == 当前长度）
applyPatch(state, { kind: 2, k: ['requests', 1, 'response'], i: 0, v: [{ value: '思考A' }] });
applyPatch(state, { kind: 2, k: ['requests', 1, 'response'], i: 1, v: [{ value: '回答B' }] });
assert.deepStrictEqual(state.requests[1].response.map((p) => p.value), ['思考A', '回答B']);

// 3) 带 i 无 v = 删除下标元素（pendingRequests）
applyPatch(state, { kind: 2, k: ['pendingRequests'], i: 1 });
assert.strictEqual(state.pendingRequests.length, 1);
assert.strictEqual(state.pendingRequests[0].id, 'p0');

// 4) 中断判定
assert.strictEqual(isRequestAborted({ elapsedMs: 0 }), true);
assert.strictEqual(isRequestAborted({ elapsedMs: 0, result: { timings: {} } }), false);
assert.strictEqual(isRequestAborted({ result: { timings: {} } }), false);

// 5) 缺少 v 的其它路径不应抛错
applyPatch(state, { kind: 2, k: ['requests', 1, 'response'], i: 99 });

console.log('PASS: 补丁语义（追加/索引插入/删除/中断判定）符合预期');
