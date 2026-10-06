'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { checkRepo, frontmatter } = require('../scripts/check-repo.cjs');

test('the repo holds only approved example media, no personal data, and well-formed skills', () => {
  assert.deepEqual(checkRepo(), []);
});

test('frontmatter reader', () => {
  const meta = frontmatter('---\nname: my-skill\ndescription: Does a thing.\nmetadata:\n  version: "1.2.3"\n---\n# Title\n');
  assert.deepEqual(meta, { name: 'my-skill', description: 'Does a thing.', version: '1.2.3' });
  assert.equal(frontmatter('# no frontmatter\n'), null);
});
