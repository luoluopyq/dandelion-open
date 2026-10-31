import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAppLink, relativeWikiPage } from '../node_modules/.wiki-view-test/links.js';

// Model a nested click target and its containing anchor without requiring a browser.
class ClickTarget {
  constructor(href) { this.href = href; }
  closest(selector) { return selector === 'a[href]' ? this : null; }
  getAttribute(name) { return name === 'href' ? this.href : null; }
}
globalThis.Element = ClickTarget;

function click(href, options = {}) {
  const calls = [];
  const event = {
    type: 'click', button: 0, defaultPrevented: false,
    target: new ClickTarget(href),
    preventDefault() { this.defaultPrevented = true; },
    ...options,
  };
  handleAppLink(event, {
    knowledge: locator => calls.push(['knowledge', locator]),
    page: page => calls.push(['page', page]),
    external: async url => { calls.push(['external', url]); },
    notice: message => calls.push(['notice', message]),
  });
  return { event, calls };
}

test('知识整理结果在应用内预览，普通点击及中键均取消原生导航', () => {
  for (const options of [{}, { type: 'auxclick', button: 1 }, { ctrlKey: true }, { metaKey: true }]) {
    const { event, calls } = click('#knowledge-page/space_ab/%E7%AC%94%E8%AE%B0.md', options);
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(calls, [['knowledge', { spaceId: 'space_ab', page: '笔记.md' }]]);
  }
  assert.deepEqual(click('#knowledge/s/chunk_1').calls, [['knowledge', { spaceId: 's', chunkId: 'chunk_1' }]]);
});

test('相对文章链接交给阅读器，编码文件名与锚点不会成为 webview 路径', () => {
  const { event, calls } = click('./%E7%AC%94%E8%AE%B0.md#介绍');
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(calls, [['page', '笔记.md']]);
});

test('外部链接通过系统处理器打开，带查询参数和 target 的链接不离开应用', () => {
  for (const url of ['https://example.com/readme.md?q=1&lang=zh#intro', 'http://localhost:8080/', 'mailto:reader@example.com']) {
    const { event, calls } = click(url);
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(calls, [['external', url]]);
  }
});

test('未知路径、无效引用和危险协议只提示错误，不触发页面导航', () => {
  for (const href of ['../notes.md', 'file:///tmp/notes.md', 'C:\\notes.md', 'javascript:alert(1)', 'data:text/html,hello', '/missing-page', '#knowledge-page/s/%GG.md']) {
    const { event, calls } = click(href);
    assert.equal(event.defaultPrevented, true, href);
    assert.equal(calls[0]?.[0], 'notice', href);
  }
});

test('组件已处理的切页和右键事件不被全局处理器重复打开', () => {
  assert.deepEqual(click('TOPIC-1.md', { defaultPrevented: true }).calls, []);
  assert.deepEqual(click('TOPIC-1.md', { type: 'auxclick', button: 2 }).calls, []);
});

test('文章解析拒绝编码路径穿越、绝对路径和控制字符', () => {
  for (const href of ['%2e%2e%2fsecret.md', '%2fprivate.md', '%5csecret.md', '%00notes.md', 'https://example.com/a.md', '//example.com/a.md', '%GG.md']) {
    assert.equal(relativeWikiPage(href), null, href);
  }
});

test('浏览器打开失败会显示提示，同时保持应用页面', async () => {
  const notices = [];
  const event = {
    type: 'click', button: 0, defaultPrevented: false,
    target: new ClickTarget('https://example.com/'),
    preventDefault() { this.defaultPrevented = true; },
  };
  handleAppLink(event, {
    knowledge() { assert.fail('unexpected knowledge'); },
    page() { assert.fail('unexpected page'); },
    external: async () => { throw new Error('browser unavailable'); },
    notice: message => notices.push(message),
  });
  await Promise.resolve();
  assert.equal(event.defaultPrevented, true);
  assert.match(notices[0], /browser unavailable/);
});
