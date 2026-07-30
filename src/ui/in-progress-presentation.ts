export interface InProgressPresentation<T> {
  visible: T[];
  canExpand: boolean;
}

export function inProgressPresentation<T>(
  items: readonly T[],
  expanded: boolean,
  collapsedLimit = 3,
): InProgressPresentation<T> {
  return {
    visible: expanded ? [...items] : items.slice(0, collapsedLimit),
    canExpand: items.length > collapsedLimit,
  };
}
