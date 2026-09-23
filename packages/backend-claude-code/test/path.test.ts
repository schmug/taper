import { describe, expect, it } from 'vitest';
import { isInside, matchPathPattern, normalizePath } from '../src/path.ts';

const CTX = { cwd: '/w/repo', home: '/home/u', anchorDir: '/w/repo' };

describe('normalizePath', () => {
  it.each([
    ['/a/b/../c', '/a/c'],
    ['/a//b/./c/', '/a/b/c'],
    ['rel/x', '/w/repo/rel/x'],
    ['./x', '/w/repo/x'],
    ['../x', '/w/x'],
    ['~/x', '/home/u/x'],
    ['~', '/home/u'],
    ['/../..', '/'],
    ['/', '/'],
  ])('%j → %j', (path, normalized) => {
    expect(normalizePath(path, '/w/repo', '/home/u')).toBe(normalized);
  });
});

describe('isInside', () => {
  it.each([
    ['/w/repo/a', '/w/repo', true],
    ['/w/repo', '/w/repo', true],
    ['/w/repo2/a', '/w/repo', false],
    ['/w', '/w/repo', false],
    ['/anything', '/', true],
  ])('%j in %j → %s', (path, dir, inside) => {
    expect(isInside(path, dir)).toBe(inside);
  });
});

describe('matchPathPattern', () => {
  it.each<[string, 'allow' | 'deny', string, boolean]>([
    ['**/x.txt', 'allow', '/w/repo/a/b/x.txt', true],
    ['**/x.txt', 'allow', '/w/repo/x.txt', true],
    ['docs/', 'allow', '/w/repo/docs/a.md', true],
    ['docs', 'allow', '/w/repo/docs/a.md', true],
    ['docs', 'allow', '/w/repo/sub/docs', true],
    ['a/b', 'allow', '/w/repo/a/b/c', true],
    ['a/b', 'allow', '/w/repo/x/a/b', false],
    ['data/**', 'allow', '/w/repo/data', true],
    ['file?.txt', 'allow', '/w/repo/file1.txt', true],
    ['file?.txt', 'allow', '/w/repo/file10.txt', false],
    ['file[ab].txt', 'allow', '/w/repo/fileb.txt', true],
    ['file[ab].txt', 'allow', '/w/repo/filec.txt', false],
    ['\\*.txt', 'allow', '/w/repo/*.txt', true],
    ['\\*.txt', 'allow', '/w/repo/a.txt', false],
    ['//etc/hosts', 'deny', '/etc/hosts', true],
    ['//etc', 'deny', '/etc/hosts', true],
    ['~/.ssh/**', 'deny', '/home/u/.ssh/id_rsa', true],
    ['/secrets/**', 'deny', '/w/repo/secrets/k', true],
    ['/secrets/**', 'deny', '/w/repo/x/secrets/k', false],
    ['src/**', 'allow', '/w/repo/pkg/src/a', false],
    ['src/**', 'deny', '/w/repo/pkg/src/a', true],
    ['*.env', 'deny', '/other/place/a.env', false],
    ['//', 'deny', '/anything/at/all', true],
  ])('%j (%s) vs %j → %s', (pattern, polarity, path, matched) => {
    expect(matchPathPattern(pattern, polarity, CTX, path)).toBe(matched);
  });

  it('anchors /path at the source directory', () => {
    const ctx = { ...CTX, anchorDir: '/home/u/.claude' };
    expect(matchPathPattern('/agents/*.md', 'allow', ctx, '/home/u/.claude/agents/a.md')).toBe(
      true,
    );
    expect(matchPathPattern('/agents/*.md', 'allow', ctx, '/w/repo/agents/a.md')).toBe(false);
  });
});
