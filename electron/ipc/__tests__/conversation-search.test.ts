import { describe, it, expect } from 'vitest';
import { matchConversation, messageTextForSearch } from '../conversation-search';

describe('messageTextForSearch', () => {
  it('returns a raw string content as-is', () => {
    expect(messageTextForSearch('hello world')).toBe('hello world');
  });

  it('joins text parts and ignores non-text parts', () => {
    const content = [
      { type: 'text', text: 'first' },
      { type: 'image', image: 'data:...' },
      { type: 'tool-call', toolName: 'x' },
      { type: 'text', text: 'second' },
    ];
    expect(messageTextForSearch(content)).toBe('first second');
  });

  it('returns empty for null / non-array / no text', () => {
    expect(messageTextForSearch(null)).toBe('');
    expect(messageTextForSearch(42)).toBe('');
    expect(messageTextForSearch([{ type: 'image', image: 'x' }])).toBe('');
  });
});

describe('matchConversation', () => {
  const conv = (over: Record<string, unknown>) => ({
    title: null,
    fallbackTitle: null,
    messages: [],
    ...over,
  });

  it('returns null for an empty/whitespace term (no filter)', () => {
    expect(matchConversation(conv({ title: 'anything' }), '   ')).toBeNull();
    expect(matchConversation(conv({ title: 'anything' }), '')).toBeNull();
  });

  it('matches the title (case-insensitive) with the title as snippet', () => {
    const hit = matchConversation(conv({ title: 'Prometheus Dashboard' }), 'prometheus');
    expect(hit).toEqual({ matchedIn: 'title', snippet: 'Prometheus Dashboard' });
  });

  it('falls back to fallbackTitle when title is null', () => {
    const hit = matchConversation(conv({ title: null, fallbackTitle: 'Untitled Chat 3' }), 'chat 3');
    expect(hit?.matchedIn).toBe('title');
  });

  it('matches message content and returns a snippet around the hit', () => {
    const c = conv({
      title: 'Some title',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'unrelated preamble' }] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'The connection refused error came from the kube-prometheus service' }],
        },
      ],
    });
    const hit = matchConversation(c, 'connection refused');
    expect(hit?.matchedIn).toBe('content');
    expect(hit?.snippet.toLowerCase()).toContain('connection refused');
  });

  it('prioritizes a title match over a content match', () => {
    const c = conv({
      title: 'deploy notes',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'deploy the thing' }] }],
    });
    const hit = matchConversation(c, 'deploy');
    expect(hit).toEqual({ matchedIn: 'title', snippet: 'deploy notes' });
  });

  it('returns null when neither title nor content contains the term', () => {
    const c = conv({
      title: 'hello',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'world' }] }],
    });
    expect(matchConversation(c, 'zzz-nomatch')).toBeNull();
  });

  it('adds ellipses when the match is in the middle of a long message', () => {
    const long = 'x'.repeat(200) + ' NEEDLE ' + 'y'.repeat(200);
    const c = conv({ messages: [{ content: [{ type: 'text', text: long }] }] });
    const hit = matchConversation(c, 'needle');
    expect(hit?.matchedIn).toBe('content');
    expect(hit?.snippet.startsWith('…')).toBe(true);
    expect(hit?.snippet.endsWith('…')).toBe(true);
    expect(hit?.snippet.toLowerCase()).toContain('needle');
  });
});
