import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { beforeEach, test } from 'node:test';

// The app imports its own modules without an extension, as Vite resolves them; Node is told to do the same.
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error;
      return next(`${specifier}.ts`, context);
    }
  },
});
// No window is drawn, so the motion that sees one out finds nothing to animate.
globalThis.document ??= { documentElement: {}, querySelector: () => null };
globalThis.CSS ??= { escape: (value) => value };
const { useWorkspaceStore, minimizeWindows, setRootNames } = await import('../src/stores/workspace.ts');

const store = () => useWorkspaceStore.getState();
const saved = () => store().snapshot();
const savedWindow = (id) => saved().windows.find((window) => window.id === id);
/** What a window shows, as it is written down for the server and for other devices. */
const shown = (id) => {
  const window = savedWindow(id);
  return { rootSlug: window.rootSlug, logicalPath: window.logicalPath, selectedItems: window.selectedItems, title: window.title };
};
const tabIds = (id) => savedWindow(id).tabs.map((tab) => tab.id);
const activeTab = (id) => savedWindow(id).activeTabId;
const focusedIds = () => saved().windows.filter((window) => window.focused).map((window) => window.id);
const lastWindowId = () => saved().windows.at(-1).id;
const navigate = (id, rootSlug, logicalPath) => store().updateWindow(id, { rootSlug, logicalPath, selectedItems: [] });

const savedFileWindow = (patch) => ({
  id: 'win_1',
  rootSlug: 'home',
  logicalPath: '/',
  title: 'Home',
  x: 0,
  y: 0,
  width: 800,
  height: 600,
  zIndex: 100,
  minimized: false,
  maximized: false,
  focused: false,
  selectedItems: [],
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

const emptyWorkspace = { activeWindowId: null, windows: [], sidebar: { collapsed: false }, inspector: { open: false, width: 300 }, shelf: { collapsed: false } };

beforeEach(() => {
  setRootNames([
    { slug: 'home', name: 'Home' },
    { slug: 'media', name: 'Media' },
  ]);
  useWorkspaceStore.setState({ appWindows: [], previewWindows: [] });
  store().hydrate(emptyWorkspace);
});

test('a new window shows the folder it was opened on, in a tab of its own, and has the focus', () => {
  store().openWindow({ rootSlug: 'home', logicalPath: '/docs', title: 'docs' });
  const id = lastWindowId();
  assert.deepEqual(shown(id), { rootSlug: 'home', logicalPath: '/docs', selectedItems: [], title: 'docs' });
  assert.equal(tabIds(id).length, 1);
  assert.equal(activeTab(id), tabIds(id)[0]);
  assert.deepEqual(focusedIds(), [id]);
  assert.equal(saved().activeWindowId, id);
});

test('a new tab opens beside the one it came from and is shown; the tab left keeps its selection', () => {
  store().openWindow({ rootSlug: 'home', logicalPath: '/', title: 'Home' });
  const id = lastWindowId();
  store().selectItems(id, ['/a.txt']);
  const first = activeTab(id);
  store().openTab(id, { rootSlug: 'media', logicalPath: '/clips' });
  const second = activeTab(id);
  store().activateTab(id, first);
  store().openTab(id, { rootSlug: 'home', logicalPath: '/docs' });
  const third = activeTab(id);

  assert.deepEqual(tabIds(id), [first, third, second], 'opened right of the tab it was opened from');
  assert.deepEqual(shown(id), { rootSlug: 'home', logicalPath: '/docs', selectedItems: [], title: 'docs' });
  store().activateTab(id, first);
  assert.deepEqual(shown(id), { rootSlug: 'home', logicalPath: '/', selectedItems: ['/a.txt'], title: 'Home' });
});

test('each tab keeps its own folder and selection across switches, after going somewhere while in front', () => {
  store().openWindow({ rootSlug: 'home', logicalPath: '/', title: 'Home' });
  const id = lastWindowId();
  const first = activeTab(id);
  store().selectItems(id, ['/one']);
  store().openTab(id, { rootSlug: 'home', logicalPath: '/' });
  const second = activeTab(id);
  navigate(id, 'media', '/clips/2024');
  store().selectItems(id, ['/clips/2024/a.mp4', '/clips/2024/b.mp4']);

  store().activateTab(id, first);
  assert.deepEqual(shown(id), { rootSlug: 'home', logicalPath: '/', selectedItems: ['/one'], title: 'Home' });
  navigate(id, 'home', '/docs');
  assert.deepEqual(shown(id), { rootSlug: 'home', logicalPath: '/docs', selectedItems: [], title: 'docs' }, 'going somewhere starts with nothing selected');

  store().activateTab(id, second);
  assert.deepEqual(shown(id), { rootSlug: 'media', logicalPath: '/clips/2024', selectedItems: ['/clips/2024/a.mp4', '/clips/2024/b.mp4'], title: '2024' });
  store().activateTab(id, first);
  assert.deepEqual(shown(id), { rootSlug: 'home', logicalPath: '/docs', selectedItems: [], title: 'docs' }, 'the background tab is where it was taken');
  const tabs = savedWindow(id).tabs;
  assert.deepEqual(tabs.map(({ rootSlug, logicalPath }) => `${rootSlug}:${logicalPath}`), ['home:/docs', 'media:/clips/2024']);
});

test('closing the tab in front shows the one that takes its place, with its own selection; the last tab stays', () => {
  store().openWindow({ rootSlug: 'home', logicalPath: '/', title: 'Home' });
  const id = lastWindowId();
  const first = activeTab(id);
  store().openTab(id, { rootSlug: 'home', logicalPath: '/a' });
  const second = activeTab(id);
  store().openTab(id, { rootSlug: 'home', logicalPath: '/b' });
  store().selectItems(id, ['/b/x']);
  const third = activeTab(id);
  store().activateTab(id, second);
  store().selectItems(id, ['/a/y']);
  store().activateTab(id, first);

  store().closeTab(id, first);
  assert.deepEqual(tabIds(id), [second, third]);
  assert.equal(activeTab(id), second, 'the tab to the right takes its place');
  assert.deepEqual(shown(id), { rootSlug: 'home', logicalPath: '/a', selectedItems: ['/a/y'], title: 'a' });

  store().activateTab(id, third);
  store().closeTab(id, third);
  assert.equal(activeTab(id), second, 'closing the rightmost shows the one left of it');
  assert.deepEqual(shown(id).logicalPath, '/a');

  store().closeTab(id, second);
  assert.deepEqual(tabIds(id), [second], 'a window keeps its last tab');
});

test('closing a tab behind leaves what is shown as it was', () => {
  store().openWindow({ rootSlug: 'home', logicalPath: '/', title: 'Home' });
  const id = lastWindowId();
  const first = activeTab(id);
  store().openTab(id, { rootSlug: 'home', logicalPath: '/a' });
  store().selectItems(id, ['/a/1']);
  store().closeTab(id, first);
  assert.deepEqual(shown(id), { rootSlug: 'home', logicalPath: '/a', selectedItems: ['/a/1'], title: 'a' });
  assert.equal(tabIds(id).length, 1);
});

test('deselect lets go of a gone item in the shown selection and in every hidden tab, matched by each tab\'s own root', () => {
  store().hydrate({
    ...emptyWorkspace,
    windows: [
      savedFileWindow({
        rootSlug: 'home',
        logicalPath: '/',
        selectedItems: ['/docs', '/docs/a.txt', '/docsx', '/b.txt'],
        activeTabId: 'tab_home',
        tabs: [
          { id: 'tab_home', rootSlug: 'home', logicalPath: '/' },
          { id: 'tab_media', rootSlug: 'media', logicalPath: '/', selectedItems: ['/docs', '/docs/c.mp4', '/clips'] },
        ],
      }),
    ],
  });

  store().deselect([{ rootSlug: 'home', path: '/docs' }]);
  assert.deepEqual(shown('win_1').selectedItems, ['/docsx', '/b.txt'], 'shown selection drops the item and what is inside it');
  store().deselect([{ rootSlug: 'media', path: '/docs' }]);
  assert.deepEqual(shown('win_1').selectedItems, ['/docsx', '/b.txt'], 'shown selection of another root is untouched');
  store().activateTab('win_1', 'tab_media');
  assert.deepEqual(shown('win_1').selectedItems, ['/clips'], 'hidden tab dropped the item and what is inside it');
});

test('deselect leaves a workspace it has nothing to take from as it was', () => {
  store().hydrate({ ...emptyWorkspace, windows: [savedFileWindow({ selectedItems: ['/b.txt'], activeTabId: 'tab_home', tabs: [{ id: 'tab_home', rootSlug: 'home', logicalPath: '/' }] })] });
  const [before] = saved().windows;
  store().deselect([{ rootSlug: 'home', path: '/docs' }]);
  assert.equal(saved().windows[0], before);
});

test('a moved folder takes every tab showing it, or a folder inside it, along with its selection', () => {
  store().hydrate({
    ...emptyWorkspace,
    windows: [
      savedFileWindow({
        logicalPath: '/old/sub',
        selectedItems: ['/old/sub/a'],
        activeTabId: 't1',
        tabs: [
          { id: 't1', rootSlug: 'home', logicalPath: '/old/sub' },
          { id: 't2', rootSlug: 'home', logicalPath: '/old', selectedItems: ['/old/sub'] },
          { id: 't3', rootSlug: 'home', logicalPath: '/other', selectedItems: ['/other/x'] },
        ],
      }),
    ],
  });
  store().followFolder({ rootSlug: 'home', path: '/old' }, { rootSlug: 'home', path: '/new' });
  assert.deepEqual(shown('win_1'), { rootSlug: 'home', logicalPath: '/new/sub', selectedItems: ['/new/sub/a'], title: 'sub' });
  store().activateTab('win_1', 't2');
  assert.deepEqual(shown('win_1'), { rootSlug: 'home', logicalPath: '/new', selectedItems: ['/new/sub'], title: 'new' });
  store().activateTab('win_1', 't3');
  assert.deepEqual(shown('win_1'), { rootSlug: 'home', logicalPath: '/other', selectedItems: ['/other/x'], title: 'other' });
});

test('the focus moves with clicks, and passes to the window in front when the focused one is minimized or closed', () => {
  store().openWindow({ rootSlug: 'home', logicalPath: '/a', title: 'a' });
  const a = lastWindowId();
  store().openWindow({ rootSlug: 'home', logicalPath: '/b', title: 'b' });
  const b = lastWindowId();
  store().openWindow({ rootSlug: 'home', logicalPath: '/c', title: 'c' });
  const c = lastWindowId();
  assert.deepEqual(focusedIds(), [c]);

  store().focusWindow(a);
  assert.deepEqual(focusedIds(), [a]);
  assert.equal(saved().activeWindowId, a);

  minimizeWindows([a]);
  assert.deepEqual(focusedIds(), [c], 'the window in front of those left takes the focus');
  store().closeWindow(c);
  assert.deepEqual(focusedIds(), [b]);
  minimizeWindows([b]);
  assert.deepEqual(focusedIds(), [], 'with every window put away, none has the focus');
  assert.equal(saved().activeWindowId, null);

  store().updateWindow(a, { minimized: false });
  store().focusWindow(a);
  assert.deepEqual(focusedIds(), [a]);
  store().closeWindow(b);
  assert.deepEqual(focusedIds(), [a], 'closing a window behind leaves the focus where it is');
});

test('an app window in front is saved as no window having the focus', () => {
  store().openWindow({ rootSlug: 'home', logicalPath: '/a', title: 'a' });
  const a = lastWindowId();
  store().openApp('settings');
  assert.deepEqual(focusedIds(), []);
  assert.equal(saved().activeWindowId, null);
  store().focusWindow(a);
  assert.deepEqual(focusedIds(), [a]);
  store().focusWindow('app_settings');
  store().closeWindow('app_settings');
  assert.deepEqual(focusedIds(), [a], 'closing the app window gives the focus back to the file window in front');
});

const severalWindows = {
  activeWindowId: 'win_b',
  windows: [
    savedFileWindow({
      id: 'win_a',
      rootSlug: 'media',
      logicalPath: '/clips',
      title: 'clips',
      zIndex: 100,
      selectedItems: ['/clips/1.mp4'],
      inspectorOpen: true,
      activeTabId: 'tab_a2',
      tabs: [
        { id: 'tab_a1', rootSlug: 'home', logicalPath: '/', selectedItems: ['/x', '/y'] },
        { id: 'tab_a2', rootSlug: 'media', logicalPath: '/clips' },
        { id: 'tab_a3', rootSlug: 'home', logicalPath: '/docs', selectedItems: [] },
      ],
      createdAt: 10,
      updatedAt: 20,
    }),
    savedFileWindow({
      id: 'win_b',
      rootSlug: 'home',
      logicalPath: '/',
      title: 'Home',
      x: 40,
      y: 30,
      zIndex: 102,
      focused: true,
      sidebarOpen: false,
      activeTabId: 'tab_b1',
      tabs: [{ id: 'tab_b1', rootSlug: 'home', logicalPath: '/' }],
      createdAt: 11,
      updatedAt: 21,
    }),
    savedFileWindow({
      id: 'win_c',
      rootSlug: 'home',
      logicalPath: '/music',
      title: 'music',
      zIndex: 101,
      minimized: true,
      scrollTop: 120,
      activeTabId: 'tab_c1',
      tabs: [
        { id: 'tab_c1', rootSlug: 'home', logicalPath: '/music' },
        { id: 'tab_c2', rootSlug: 'media', logicalPath: '/', selectedItems: ['/podcasts'] },
      ],
      createdAt: 12,
      updatedAt: 22,
    }),
  ],
  sidebar: { collapsed: false, width: 220 },
  inspector: { open: false, width: 300 },
  shelf: { collapsed: true, x: 10, y: 20 },
};

const byId = (workspace) => ({ ...workspace, windows: [...workspace.windows].sort((a, b) => a.id.localeCompare(b.id)) });

test('a workspace with several windows and tabs is saved back exactly as it was loaded', () => {
  store().hydrate(severalWindows);
  assert.deepEqual(JSON.parse(JSON.stringify(byId(saved()))), byId(severalWindows));
});

test('a window saved before there were tabs comes back in a tab of its own, and is saved with it', () => {
  const { tabs: _tabs, activeTabId: _active, ...legacy } = savedFileWindow({ logicalPath: '/docs', title: 'docs', selectedItems: ['/docs/a'] });
  store().hydrate({ ...emptyWorkspace, windows: [legacy] });
  const window = savedWindow('win_1');
  assert.equal(window.tabs.length, 1);
  assert.equal(window.activeTabId, window.tabs[0].id);
  assert.deepEqual({ rootSlug: window.tabs[0].rootSlug, logicalPath: window.tabs[0].logicalPath }, { rootSlug: 'home', logicalPath: '/docs' });
  assert.deepEqual(shown('win_1'), { rootSlug: 'home', logicalPath: '/docs', selectedItems: ['/docs/a'], title: 'docs' });
  assert.deepEqual(focusedIds(), ['win_1'], 'the window on top takes the focus when none was saved');
});

test('a window moved by a client that does not know tabs shows where it was moved to, in that tab too', () => {
  // A client from before tabs moves the window and saves it, carrying the tabs it read along unchanged.
  store().hydrate({
    ...emptyWorkspace,
    windows: [
      savedFileWindow({
        logicalPath: '/moved',
        title: 'moved',
        selectedItems: ['/moved/a'],
        activeTabId: 't1',
        tabs: [
          { id: 't1', rootSlug: 'home', logicalPath: '/before' },
          { id: 't2', rootSlug: 'media', logicalPath: '/', selectedItems: [] },
        ],
      }),
    ],
  });
  assert.deepEqual(shown('win_1'), { rootSlug: 'home', logicalPath: '/moved', selectedItems: ['/moved/a'], title: 'moved' });
  store().activateTab('win_1', 't2');
  store().activateTab('win_1', 't1');
  assert.deepEqual(shown('win_1'), { rootSlug: 'home', logicalPath: '/moved', selectedItems: ['/moved/a'], title: 'moved' }, 'coming back to the tab finds it where the window was');
});
