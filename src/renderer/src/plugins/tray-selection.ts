export interface TraySelection { excluded: readonly string[] }

/** Defaults apply to unloaded and newly registered panels as well as currently visible ones. */
export function parseTraySelection(stored: string | null): TraySelection {
  if (stored === null) return { excluded: [] }
  if (stored.length > 8192) throw new Error('Tray selection is too large / 托盘显示组合超出限制')
  const value: unknown = JSON.parse(stored)
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !('excluded' in value) ||
      !Array.isArray(value.excluded) || value.excluded.length > 64 ||
      value.excluded.some(item => typeof item !== 'string' || !/^[a-z][a-z0-9.-]{0,127}$/.test(item)) || new Set(value.excluded).size !== value.excluded.length) {
    throw new Error('Invalid tray selection / 托盘显示组合无效')
  }
  return { excluded: value.excluded }
}

export function isTrayPanelSelected(selection: TraySelection, id: string): boolean {
  return !selection.excluded.includes(id)
}

/** Changing one checkbox never enumerates currently loaded panels. */
export function updateTraySelection(selection: TraySelection, id: string, checked: boolean): TraySelection {
  if (!/^[a-z][a-z0-9.-]{0,127}$/.test(id)) throw new Error('Invalid tray panel / 托盘显示项无效')
  if (isTrayPanelSelected(selection, id) === checked) return selection
  if (!checked && selection.excluded.length >= 64) throw new Error('Tray selection is too large / 托盘显示组合超出限制')
  return { excluded: checked ? selection.excluded.filter(panel => panel !== id) : [...selection.excluded, id] }
}
