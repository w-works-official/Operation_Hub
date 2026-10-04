import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const parser = require('../mockups/operations-hub/relation-import-parser.js');

const oneToMany = parser.parseRelationHierarchyRows([
  ['A', 'B', 'C'],
  ['1000-1', '2000-1', '3000-1'],
  ['1000-1', '2000-2', ''],
  ['1000-1', '2000-2', '']
]);
assert.equal(oneToMany.valid, true);
assert.deepEqual(oneToMany.codes, ['1000-1', '2000-1', '3000-1', '2000-2']);
assert.deepEqual(oneToMany.edges.map(edge => [edge.parentCode, edge.childCode]), [
  ['1000-1', '2000-1'], ['2000-1', '3000-1'], ['1000-1', '2000-2']
]);
assert.equal(oneToMany.duplicateEdgeCount, 1, 'duplicate rows must be accepted and deduplicated');

const gap = parser.parseRelationHierarchyRows([['A', 'B', 'C'], ['1000-1', '', '3000-1']]);
assert.equal(gap.valid, false);
assert.match(gap.errors.join('\n'), /B열이 비어 있는데 C열/);

const cycle = parser.parseRelationHierarchyRows([['A', 'B'], ['1000-1', '2000-1'], ['2000-1', '1000-1']]);
assert.equal(cycle.valid, false);
assert.match(cycle.errors.join('\n'), /순환 관계/);

const wrongHeader = parser.parseRelationHierarchyRows([['A', 'C'], ['1000-1', '2000-1']]);
assert.equal(wrongHeader.valid, false);
assert.match(wrongHeader.errors.join('\n'), /B1 헤더/);

console.log('operations hub relation import parser tests passed');
