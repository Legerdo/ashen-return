type Child = Node | string | number | null | undefined | false;

export interface Props {
  class?: string;
  id?: string;
  text?: string;
  title?: string;
  style?: string;
  type?: string;
  value?: string;
  disabled?: boolean;
  checked?: boolean;
  role?: string;
  tabindex?: number;
  attrs?: Record<string, string>;
  data?: Record<string, string>;
  onclick?: (e: MouseEvent) => void;
  oncontextmenu?: (e: MouseEvent) => void;
  ondblclick?: (e: MouseEvent) => void;
  oninput?: (e: Event) => void;
  onchange?: (e: Event) => void;
  onkeydown?: (e: KeyboardEvent) => void;
  onpointerdown?: (e: PointerEvent) => void;
  onpointerenter?: (e: PointerEvent) => void;
  onpointerleave?: (e: PointerEvent) => void;
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    if (props.class) el.className = props.class;
    if (props.id) el.id = props.id;
    if (props.text !== undefined) el.textContent = props.text;
    if (props.title) el.title = props.title;
    if (props.style) el.setAttribute('style', props.style);
    if (props.role) el.setAttribute('role', props.role);
    if (props.tabindex !== undefined) el.tabIndex = props.tabindex;
    if (props.type && 'type' in el) (el as HTMLInputElement).type = props.type;
    if (props.value !== undefined && 'value' in el) (el as HTMLInputElement).value = props.value;
    if (props.disabled !== undefined && 'disabled' in el) (el as HTMLButtonElement).disabled = props.disabled;
    if (props.checked !== undefined && 'checked' in el) (el as HTMLInputElement).checked = props.checked;
    for (const [k, v] of Object.entries(props.attrs ?? {})) el.setAttribute(k, v);
    for (const [k, v] of Object.entries(props.data ?? {})) el.dataset[k] = v;
    if (props.onclick) el.addEventListener('click', props.onclick as EventListener);
    if (props.oncontextmenu) el.addEventListener('contextmenu', props.oncontextmenu as EventListener);
    if (props.ondblclick) el.addEventListener('dblclick', props.ondblclick as EventListener);
    if (props.oninput) el.addEventListener('input', props.oninput);
    if (props.onchange) el.addEventListener('change', props.onchange);
    if (props.onkeydown) el.addEventListener('keydown', props.onkeydown as EventListener);
    if (props.onpointerdown) el.addEventListener('pointerdown', props.onpointerdown as EventListener);
    if (props.onpointerenter) el.addEventListener('pointerenter', props.onpointerenter as EventListener);
    if (props.onpointerleave) el.addEventListener('pointerleave', props.onpointerleave as EventListener);
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'number' ? String(c) : c);
  }
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function btn(label: string, onclick: () => void, opts: { class?: string; disabled?: boolean; title?: string; testid?: string } = {}): HTMLButtonElement {
  const b = h('button', { class: `btn ${opts.class ?? ''}`, type: 'button', ...(opts.disabled !== undefined ? { disabled: opts.disabled } : {}), ...(opts.title ? { title: opts.title } : {}), onclick: (e) => {
    e.stopPropagation();
    onclick();
  } }, label);
  if (opts.testid) b.dataset['testid'] = opts.testid;
  return b;
}

export function fmtCredits(n: number): string {
  return `${Math.round(n).toLocaleString('ko-KR')}cr`;
}

export function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}
