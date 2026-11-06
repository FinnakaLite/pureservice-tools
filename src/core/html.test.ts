import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { commandLines, escapeHtml, htmlToLines, mentionedUserIds, mentionHtml } from './html.ts';

// Real markup captured from smith.pureservice.com during the spike.
const MENTION = '<a class="x-ps-autocomplete-mention" href="mailto:finn.mccann@smith.no" data-mention="true" data-mention-user-id="2611" data-mention-firstname="Finn" data-mention-lastname="McCann">@Finn McCann</a>';

describe('htmlToLines', () => {
  it('splits paragraphs and line breaks', () => assert.deepEqual(htmlToLines('<p>a</p><p>b<br>c</p>'), ['a', 'b', 'c']));
  it('turns mentions into plain @Name', () => assert.deepEqual(htmlToLines(`<p>Tagging me: ${MENTION}</p>`), ['Tagging me: @Finn McCann']));
  it('decodes entities incl. Norwegian letters', () => assert.deepEqual(htmlToLines('<p>bl&aring;b&aelig;r&nbsp;&amp;&#248;l</p>'), ['blåbær &øl']));
  it('drops quotes, code and comments', () =>
    assert.deepEqual(htmlToLines('<blockquote><p>!remindme 1d</p></blockquote><p><code>!remindme 2d</code> ok</p><!-- !x -->'), ['ok']));
});

describe('commandLines', () => {
  it('finds a command at line start', () => assert.deepEqual(commandLines('<p>!remindme 5d</p>'), [{ name: 'remindme', args: '5d' }]));
  it('is case-insensitive on the name and keeps args', () => assert.deepEqual(commandLines('<p>!RemindMe 10d Ring Per</p>'), [{ name: 'remindme', args: '10d Ring Per' }]));
  it('ignores a command in the middle of a line', () => assert.deepEqual(commandLines('<p>Husk at !remindme er kult</p>'), []));
  it('ignores "!!!" and "! remindme"', () => assert.deepEqual(commandLines('<p>!!!</p><p>! remindme 1d</p>'), []));
  it('finds commands on later lines', () => assert.deepEqual(commandLines('<p>Ringte kunden.</p><p>!remindme 2d</p>'), [{ name: 'remindme', args: '2d' }]));
});

describe('mentionHtml', () => {
  it('reproduces the editor markup exactly', () =>
    assert.equal(mentionHtml({ id: 2611, firstName: 'Finn', lastName: 'McCann', email: 'finn.mccann@smith.no' }), MENTION));
  it('escapes names', () => assert.match(mentionHtml({ id: 1, firstName: '<b>', lastName: 'x"y', email: null }), /&lt;b&gt;.*x&quot;y/));
});

describe('mentionedUserIds', () => {
  it('finds mention anchors, deduplicated', () =>
    assert.deepEqual(mentionedUserIds(`<p>${MENTION} og ${mentionHtml({ id: 740, firstName: 'K', lastName: 'S', email: null })} ${MENTION}</p>`), [2611, 740]));
  it('ignores escaped user text that looks like a mention', () =>
    assert.deepEqual(mentionedUserIds(`<p>«${escapeHtml(MENTION)}»</p>`), []));
  it('returns nothing for plain notes', () => assert.deepEqual(mentionedUserIds('<p>⏰ Påminnelse R-1 satt</p>'), []));
});
