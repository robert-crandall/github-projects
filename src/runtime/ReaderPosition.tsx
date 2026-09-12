import { Component, createRef, type ReactNode } from 'react';

type Props = { positionKey: string; offset: number; ready: boolean; save: (key: string, offset: number) => void; children: ReactNode };
type Position = { offset: number; anchor?: string; top?: number };

export class ReaderPosition extends Component<Props, object, Position | null> {
  private element = createRef<HTMLElement>();
  getSnapshotBeforeUpdate(previous: Props): Position | null {
    const element = this.element.current;
    if (!element || !previous.ready || !this.props.ready || previous.positionKey !== this.props.positionKey) return null;
    const boundary = element.getBoundingClientRect().top;
    // Ignore the fractional trailing pixel of the preceding message after scroll rounding.
    const anchor = [...element.querySelectorAll<HTMLElement>('[data-reader-anchor]')]
      .find(item => item.getBoundingClientRect().bottom > boundary + 1);
    return { offset: element.scrollTop, anchor: anchor?.dataset.readerAnchor, top: anchor?.getBoundingClientRect().top };
  }
  componentDidMount() { if (this.element.current && this.props.ready) this.element.current.scrollTop = this.props.offset; }
  componentDidUpdate(previous: Props, _state: object, position: Position | null) {
    const element = this.element.current;
    if (!element || !this.props.ready) return;
    if (!previous.ready || previous.positionKey !== this.props.positionKey) element.scrollTop = this.props.offset;
    else if (position) {
      const anchor = position.anchor && [...element.querySelectorAll<HTMLElement>('[data-reader-anchor]')]
        .find(item => item.dataset.readerAnchor === position.anchor);
      element.scrollTop = anchor && position.top !== undefined
        ? position.offset + anchor.getBoundingClientRect().top - position.top : position.offset;
    }
  }
  render() {
    return <article ref={this.element} className="detail" aria-label="Selected item"
      onScroll={event => { if (this.props.ready) this.props.save(this.props.positionKey, event.currentTarget.scrollTop); }}>{this.props.children}</article>;
  }
}
