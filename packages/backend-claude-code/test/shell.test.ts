import { describe, expect, it } from 'vitest';
import {
  isReadOnlyCommand,
  matchCommandPattern,
  parseShell,
  requiresExactRule,
  stripWrappers,
} from '../src/shell.ts';

describe('parseShell', () => {
  it.each<[string, string[]]>([
    ['a && b', ['a', 'b']],
    ['a || b; c', ['a', 'b', 'c']],
    ['a | b |& c', ['a', 'b', 'c']],
    ['a & b', ['a', 'b']],
    ['a\nb', ['a', 'b']],
    ['a 2>&1 | b', ['a 2>&1', 'b']],
    ['a &> log; b', ['a &> log', 'b']],
    ['a >| f', ['a >| f']],
    ["echo 'x && y'", ["echo 'x && y'"]],
    ['echo "x; y"', ['echo "x; y"']],
    ['echo x\\;y', ['echo x\\;y']],
    ['a $(b && c)', ['a $(b && c)', 'b', 'c']],
    ['a `b`', ['a `b`', 'b']],
    ['echo "$(b)"', ['echo "$(b)"', 'b']],
    ["echo '$(b)'", ["echo '$(b)'"]],
    ['a $(b $(c))', ['a $(b $(c))', 'b $(c)', 'c']],
    ['(a; b) && c', ['a', 'b', 'c']],
    ['for i in 1 2; do a $i; done', ['a $i']],
    ['for f in $(ls); do a; done', ['ls', 'a']],
    ['if a; then b; else c; fi', ['a', 'b', 'c']],
    ['while a; do b; done', ['a', 'b']],
    ['{ a; b; }', ['a', 'b']],
    ['! a', ['a']],
    ['echo $((1+2))', ['echo $((1+2))']],
    ['cat <<EOF\nx && y\nEOF\nb', ['cat <<EOF', 'b']],
    ["cat <<-'END'\n\tx; y\n\tEND\nb", ["cat <<-'END'", 'b']],
    ['cat <<< "x && y"', ['cat <<< "x && y"']],
    ['a # c && d', ['a']],
    ['a#b', ['a#b']],
    ['a;', ['a']],
    ['a &', ['a']],
    ['', []],
  ])('%j', (command, commands) => {
    expect(parseShell(command)).toEqual({ commands, unparseable: false });
  });

  it.each(['a &&', 'a ||', 'a && ', 'a &&\n', "echo 'x", 'echo "x', 'a $(b', 'a `b', 'a (b'])(
    '%j is unparseable',
    (command) => {
      expect(parseShell(command).unparseable).toBe(true);
    },
  );
});

describe('stripWrappers', () => {
  it.each([
    ['timeout 5 make', 'make'],
    ['timeout -s KILL 5 make', 'make'],
    ['timeout --signal=KILL 5s make', 'make'],
    ['timeout -k 1 5 make', 'make'],
    ['time make', 'make'],
    ['time -p make', 'make'],
    ['nice make', 'make'],
    ['nice -n 5 make', 'make'],
    ['nice -5 make', 'make'],
    ['nohup make', 'make'],
    ['stdbuf -oL make', 'make'],
    ['stdbuf -o L make', 'make'],
    ['command make', 'make'],
    ['builtin echo x', 'echo x'],
    ['noglob make', 'make'],
    ['xargs make', 'make'],
    ['xargs -n1 make', 'xargs -n1 make'],
    ['command -v make', 'command -v make'],
    ['npx make', 'npx make'],
    ['docker exec c make', 'docker exec c make'],
    ['FOO=1 make', 'make'],
    ['FOO="a b" BAR=2 make', 'make'],
    ['FOO=1 timeout 5 nice make -j2', 'make -j2'],
    ['FOO=1', 'FOO=1'],
    ['timeout', 'timeout'],
    ['  make  ', 'make'],
  ])('%j → %j', (command, stripped) => {
    expect(stripWrappers(command)).toBe(stripped);
  });
});

describe('isReadOnlyCommand', () => {
  it.each([
    'ls',
    'ls -la',
    'cat a',
    'echo hi',
    'pwd',
    'head -n1 f',
    'tail f',
    'grep x f',
    'find . -name y',
    'wc -l f',
    'which node',
    'diff a b',
    'stat f',
    'du -sh .',
    'cd ..',
    'git status',
    'git log --oneline',
    'git diff',
    'git show HEAD',
    'git rev-parse HEAD',
    'git ls-files',
    'git blame f',
    'cat <<EOF',
  ])('%j is read-only', (command) => {
    expect(isReadOnlyCommand(command)).toBe(true);
  });

  it.each([
    'rm x',
    'git',
    'git push',
    'git commit -m x',
    'echo hi > f',
    'ls >> f',
    'find . -delete',
    'find . -exec rm {} ;',
    'npm test',
    './ls',
  ])('%j is not read-only', (command) => {
    expect(isReadOnlyCommand(command)).toBe(false);
  });
});

describe('requiresExactRule', () => {
  it.each([
    ['watch -n 1 x', true],
    ['setsid x', true],
    ['ionice -c3 x', true],
    ['flock /tmp/l x', true],
    ['find . -exec rm {} ;', true],
    ['find . -execdir x ;', true],
    ['find . -delete', true],
    ['find . -ok rm {} ;', true],
    ['find . -name x', false],
    ['make', false],
  ])('%j → %s', (command, exact) => {
    expect(requiresExactRule(command)).toBe(exact);
  });
});

describe('matchCommandPattern', () => {
  it.each([
    ['git *', 'git status', true],
    ['git *', 'git', true],
    ['git *', 'gitk', false],
    ['ls*', 'lsof', true],
    ['git * main', 'git push origin main', true],
    ['git * main', 'git main', false],
    ['* --version', 'node --version', true],
    ['a * b *', 'a x b', false],
    ['a * b *', 'a x b y', true],
    ['npm run build', 'npm run build', true],
    ['npm run build', 'npm run build:prod', false],
    ['echo *', 'echo a\nb', true],
    ['x.y *', 'xzy a', false],
    ['*', 'anything at all', true],
  ])('%j vs %j → %s', (pattern, command, matched) => {
    expect(matchCommandPattern(pattern, command)).toBe(matched);
  });
});
