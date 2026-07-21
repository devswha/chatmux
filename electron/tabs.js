import { getTargetOrigin, getTargetPartition, LOCAL_TARGET_ID } from './targetSessions.js';

const LAUNCHER_TAB_ID = 'home';

function requireTargetName(target) {
  const name = String(target?.name || '').trim();
  if (!name) {
    throw new Error('Target must have a name.');
  }
  return name;
}

function normalizeTarget(target) {
  if (!target || typeof target !== 'object') {
    throw new TypeError('Target must be an object.');
  }

  if (target.kind === 'launcher') {
    if (target.id != null && target.id !== LAUNCHER_TAB_ID) {
      throw new Error('Launcher target must use the home tab id.');
    }
    return {
      kind: 'launcher',
      id: LAUNCHER_TAB_ID,
      name: requireTargetName(target),
      url: null,
    };
  }

  if (target.kind === 'local') {
    if (target.id !== LOCAL_TARGET_ID) {
      throw new Error('Local target must use the local target id.');
    }
    return {
      kind: 'local',
      id: LOCAL_TARGET_ID,
      name: requireTargetName(target),
      url: getTargetOrigin(target),
    };
  }

  if (target.kind === 'remote') {
    getTargetPartition(target);
    return {
      kind: 'remote',
      id: String(target.id),
      name: requireTargetName(target),
      url: getTargetOrigin(target),
    };
  }

  throw new Error('Target kind must be launcher, local, or remote.');
}

export class TabsController {
  constructor() {
    this.activeTabId = LAUNCHER_TAB_ID;
    this.tabs = [
      {
        id: LAUNCHER_TAB_ID,
        title: 'ChatMux',
        kind: 'launcher',
        closable: false,
      },
    ];
  }

  getTabIdForTarget(target) {
    const normalizedTarget = normalizeTarget(target);
    if (normalizedTarget.kind === 'launcher') return LAUNCHER_TAB_ID;
    if (normalizedTarget.kind === 'local') return LOCAL_TARGET_ID;
    return `remote:${normalizedTarget.id}`;
  }

  upsertTarget(target) {
    const normalizedTarget = normalizeTarget(target);
    const tabId = this.getTabIdForTarget(normalizedTarget);
    const existingTab = this.tabs.find((tab) => tab.id === tabId);
    const nextTab = {
      id: tabId,
      title: normalizedTarget.name,
      kind: normalizedTarget.kind,
      target: normalizedTarget,
      closable: tabId !== LAUNCHER_TAB_ID,
    };

    if (existingTab) {
      Object.assign(existingTab, nextTab);
    } else {
      this.tabs.push(nextTab);
    }

    this.activeTabId = tabId;
    return nextTab;
  }

  activate(tabId) {
    const tab = this.tabs.find((item) => item.id === tabId);
    if (!tab) return null;
    this.activeTabId = tab.id;
    return tab;
  }

  remove(tabId) {
    const tab = this.tabs.find((item) => item.id === tabId);
    if (!tab || !tab.closable) return null;
    this.tabs = this.tabs.filter((item) => item.id !== tabId);
    if (this.activeTabId === tabId) {
      this.activeTabId = LAUNCHER_TAB_ID;
    }
    return tab;
  }

  removeByKind(kind) {
    const removed = this.tabs.filter((tab) => tab.kind === kind && tab.closable);
    if (!removed.length) return [];

    const removedIds = new Set(removed.map((tab) => tab.id));
    this.tabs = this.tabs.filter((tab) => !removedIds.has(tab.id));
    if (removedIds.has(this.activeTabId)) {
      this.activeTabId = LAUNCHER_TAB_ID;
    }
    return removed;
  }

  getActiveTab() {
    return this.getTab(this.activeTabId);
  }

  getTab(tabId) {
    return this.tabs.find((item) => item.id === tabId) || null;
  }

  getSerializableTabs() {
    return this.tabs.map((tab) => ({
      id: tab.id,
      targetId: tab.target?.id || null,
      title: tab.title,
      kind: tab.kind,
      closable: tab.closable,
      active: tab.id === this.activeTabId,
    }));
  }
}