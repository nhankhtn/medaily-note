import { Editor, Extension } from '@tiptap/core'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { Placeholder } from '@tiptap/extensions'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from 'tiptap-markdown'

// Same config as the web editor (src/components/ui/markdown-editor.tsx), so a
// note round-trips to identical Markdown on both sides.

/** tiptap-markdown spaces task-list items out; a note saved untouched would come back rewritten. */
const TightTaskList = Extension.create({
  name: 'tightTaskList',
  addGlobalAttributes() {
    return [
      {
        types: ['taskList'],
        attributes: {
          tight: { default: true, parseHTML: () => true, renderHTML: () => ({}) },
        },
      },
    ]
  },
})

export function createNoteEditor(
  element: HTMLElement,
  onTransaction: (editor: Editor) => void,
): Editor {
  return new Editor({
    element,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        underline: false,
        codeBlock: { HTMLAttributes: { spellcheck: 'false' } },
        link: { openOnClick: false, autolink: true },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      TightTaskList,
      Placeholder.configure({ placeholder: 'Write — # heading, - list, **bold**, `code`…' }),
      Markdown.configure({ html: false, transformPastedText: true, linkify: true }),
    ],
    editorProps: { attributes: { class: 'md-doc', 'aria-label': 'Note' } },
    onTransaction: ({ editor }) => onTransaction(editor),
  })
}

export function markdownOf(editor: Editor): string {
  return (
    editor.storage as unknown as { markdown: { getMarkdown: () => string } }
  ).markdown.getMarkdown()
}

export function setMarkdown(editor: Editor, markdown: string) {
  editor.commands.setContent(markdown, { emitUpdate: false })
}

export function applyMarkdownAction(editor: Editor, action: string) {
  const chain = editor.chain().focus()
  switch (action) {
    case 'bold':
      chain.toggleBold().run()
      break
    case 'italic':
      chain.toggleItalic().run()
      break
    case 'heading':
      chain.toggleHeading({ level: 2 }).run()
      break
    case 'list':
      chain.toggleBulletList().run()
      break
    case 'code':
      chain.toggleCode().run()
      break
    case 'link': {
      if (editor.isActive('link')) {
        chain.extendMarkRange('link').unsetLink().run()
        break
      }
      const href = window.prompt('Link URL', 'https://')?.trim()
      if (href) chain.extendMarkRange('link').setLink({ href }).run()
      break
    }
  }
}

export function isActionOn(editor: Editor, action: string): boolean {
  switch (action) {
    case 'bold':
      return editor.isActive('bold')
    case 'italic':
      return editor.isActive('italic')
    case 'heading':
      return editor.isActive('heading')
    case 'list':
      return editor.isActive('bulletList')
    case 'code':
      return editor.isActive('code')
    case 'link':
      return editor.isActive('link')
    default:
      return false
  }
}
