import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

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
const { useWorkspaceStore } = await import('../src/stores/workspace.ts');

const fileWindow = (patch) => ({
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
  focused: true,
  selectedItems: [],
  createdAt: 0,
  updatedAt: 0,
  ...patch,
});

test('deselect lets go of a gone item in the shown selection and in every hidden tab, matched by each tab\'s own root', () => {
  useWorkspaceStore.setState({
    windows: [
      fileWindow({
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

  useWorkspaceStore.getState().deselect([{ rootSlug: 'home', path: '/docs' }]);
  let [window] = useWorkspaceStore.getState().windows;
  assert.deepEqual(window.selectedItems, ['/docsx', '/b.txt'], 'shown selection drops the item and what is inside it');
  assert.deepEqual(window.tabs[1].selectedItems, ['/docs', '/docs/c.mp4', '/clips'], 'a tab of another root keeps the same path');

  useWorkspaceStore.getState().deselect([{ rootSlug: 'media', path: '/docs' }]);
  [window] = useWorkspaceStore.getState().windows;
  assert.deepEqual(window.tabs[1].selectedItems, ['/clips'], 'hidden tab drops the item and what is inside it');
  assert.deepEqual(window.selectedItems, ['/docsx', '/b.txt'], 'shown selection of another root is untouched');
});

test('deselect leaves a window it has nothing to take from as it was', () => {
  const before = fileWindow({ selectedItems: ['/b.txt'], activeTabId: 'tab_home', tabs: [{ id: 'tab_home', rootSlug: 'home', logicalPath: '/' }] });
  useWorkspaceStore.setState({ windows: [before] });
  useWorkspaceStore.getState().deselect([{ rootSlug: 'home', path: '/docs' }]);
  assert.equal(useWorkspaceStore.getState().windows[0], before);
});
