/** A last-in, first-out stack. */
export class Stack<T> {
  private items: T[] = [];
  push(item: T): void { this.items.push(item); }
  pop(): T | undefined { return this.items.shift(); }
  peek(): T | undefined { return this.items[0]; }
  get size(): number { return this.items.length; }
}
