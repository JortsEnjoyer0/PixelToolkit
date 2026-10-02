// Explorer icons: one lucide icon per node kind, plus "new X" toolbar icons drawn as the kind icon with a small plus
// badge (lucide has no plus variant for every kind). Badged icons accept the same `size` prop as lucide icons.
import { defineComponent, h, markRaw, type Component } from 'vue';
import { Clapperboard, Folder, FolderOpen, PersonStanding, Plus, TriangleAlert } from '@lucide/vue';
import type { ExplorerNode } from '../../../stores/types';

/** `icon` with a plus badge at its bottom-right (styled by .icon-plus / .icon-plus-badge in ExplorerPanel). */
export function withPlus(icon: Component, name: string): Component {
  return markRaw(defineComponent({
    name,
    props: { size: { type: [Number, String], default: 16 } },
    setup(props) {
      return () => {
        const size = Number(props.size);
        // The kind icon shrinks toward the top-left so the badge sits in the free corner (no backdrop needed)
        return h('span', { class: 'icon-plus', style: { width: `${size}px`, height: `${size}px` } }, [
          h(icon, { size: Math.round(size * 0.84) }),
          h('span', { class: 'icon-plus-badge' }, [h(Plus, { size: Math.round(size * 0.6), strokeWidth: 3 })])
        ]);
      };
    }
  }));
}

export const NewCharacterIcon = withPlus(PersonStanding, 'NewCharacterIcon');
export const NewAnimationIcon = withPlus(Clapperboard, 'NewAnimationIcon');

export function nodeIcon(n: Pick<ExplorerNode, 'kind' | 'expanded'>): Component {
  switch (n.kind) {
    case 'folder':
      return n.expanded ? FolderOpen : Folder;
    case 'character':
      return PersonStanding;
    case 'animation':
      return Clapperboard;
    default:
      return TriangleAlert;
  }
}
