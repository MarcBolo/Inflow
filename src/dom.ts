/**
 * DOM 小工具：设置 CSS 自定义属性。
 * 优先走 Obsidian 官方扩展的 setCssProps（不产生内联样式表外的散落样式），
 * 旧版 Obsidian（< 1.6）无该方法时回退到 style.setProperty。
 * CSS 变量由 styles.css 中的 var(--x, 默认值) 消费，主题可覆盖默认。
 */
export function setCssVar(el: HTMLElement, name: string, value: string): void {
  if (typeof el.setCssProps === 'function') {
    el.setCssProps({ [name]: value });
  } else {
    el.style.setProperty(name, value);
  }
}
