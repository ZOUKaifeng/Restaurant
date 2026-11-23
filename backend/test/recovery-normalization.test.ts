import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalConstraintDefinition } from './recovery-all.js';

test('restore comparison normalizes only equivalent unlimited-varchar constant arrays', () => {
  const source = "CHECK ((slug)::text <> ALL ((ARRAY['admin'::character varying, 'api'::character varying])::text[]))";
  const restored = "CHECK ((slug)::text <> ALL (ARRAY[('admin'::character varying)::text, ('api'::character varying)::text]))";
  assert.equal(canonicalConstraintDefinition(source), canonicalConstraintDefinition(restored));
  assert.notEqual(canonicalConstraintDefinition(source), canonicalConstraintDefinition(restored.replace("'admin'", "'other'")));
  const bounded = "CHECK (name = ('long'::character varying(2))::text)";
  assert.equal(canonicalConstraintDefinition(bounded), bounded);
  const variableArray = 'CHECK (value = ANY ((ARRAY[column_name])::text[]))';
  assert.equal(canonicalConstraintDefinition(variableArray), variableArray);
});
