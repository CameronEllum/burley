<script lang="ts">
  import type { CommentKind, DocComment } from '../lib/docComments'

  export interface CommentDraft {
    from: number
    to: number
    snippet: string
    line: number
    autoFocus?: boolean
  }

  let {
    comments,
    activeId,
    defaultAuthor,
    canAdd,
    draft = null,
    onnew,
    oncreatedraft,
    oncanceldraft,
    onselect,
    onreply,
    onedit,
    ondeletereply,
    ondelete,
    onclose,
  }: {
    comments: DocComment[]
    activeId: string | null
    defaultAuthor: string
    canAdd: boolean
    draft?: CommentDraft | null
    onnew: () => void
    oncreatedraft: (payload: { kind: CommentKind; author: string; body: string }) => void
    oncanceldraft: () => void
    onselect: (comment: DocComment) => void
    onreply: (id: string, author: string, body: string) => void
    onedit: (id: string, messageIndex: number, body: string) => void
    ondeletereply: (id: string, messageIndex: number) => void
    ondelete: (id: string) => void
    onclose: () => void
  } = $props()

  type FilterMode = 'all' | 'discussion' | 'edit'

  let filter = $state<FilterMode>('all')
  let listEl: HTMLElement | null = null
  let replyDrafts = $state<Record<string, string>>({})
  let editingKey = $state<string | null>(null)
  let editDraft = $state('')

  let draftAuthor = $state('')
  let draftBody = $state('')
  let draftTextareaEl = $state<HTMLTextAreaElement | null>(null)
  let lastDraftKey = ''

  const discussionCount = $derived(comments.filter((c) => c.kind === 'discussion').length)
  const editCount = $derived(comments.filter((c) => c.kind === 'edit').length)
  const visibleComments = $derived(
    filter === 'all' ? comments : comments.filter((c) => c.kind === filter),
  )

  $effect(() => {
    if (!draft) {
      lastDraftKey = ''
      return
    }
    const key = `${draft.from}:${draft.to}:${draft.line}:${draft.snippet}`
    if (key !== lastDraftKey) {
      lastDraftKey = key
      draftAuthor = defaultAuthor
      draftBody = ''
    }
    if (draft.autoFocus !== false) {
      requestAnimationFrame(() => draftTextareaEl?.focus())
    }
  })

  function submitDraft(kind: CommentKind) {
    const trimmed = draftBody.trim()
    if (!trimmed) return
    oncreatedraft({
      kind,
      author: draftAuthor.trim() || 'anonymous',
      body: trimmed,
    })
    draftBody = ''
  }

  function draftKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      oncanceldraft()
      return
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault()
      submitDraft(event.shiftKey ? 'edit' : 'discussion')
    }
  }

  $effect(() => {
    if (!activeId || !listEl) return
    const target = listEl.querySelector<HTMLElement>(`[data-comment-id="${CSS.escape(activeId)}"]`)
    target?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  })

  function beginEdit(id: string, messageIndex: number, body: string) {
    editingKey = `${id}:${messageIndex}`
    editDraft = body
  }

  function cancelEdit() {
    editingKey = null
    editDraft = ''
  }

  function saveEdit(id: string, messageIndex: number) {
    const trimmed = editDraft.trim()
    if (!trimmed) return
    onedit(id, messageIndex, trimmed)
    editingKey = null
    editDraft = ''
  }

  function submitReply(id: string) {
    const draft = (replyDrafts[id] ?? '').trim()
    if (!draft) return
    onreply(id, defaultAuthor.trim() || 'anonymous', draft)
    replyDrafts = { ...replyDrafts, [id]: '' }
  }

  function replyKeydown(id: string, event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submitReply(id)
    }
  }
</script>

<div class="cp-wrap">
  <header class="cp-head">
    <span class="cp-title">Comments</span>
    <span class="cp-count">{comments.length}</span>
    <span class="cp-grow"></span>
    <button
      type="button"
      class="cp-icon-btn"
      title="Add comment (Alt+C)"
      aria-label="Add comment"
      disabled={!canAdd}
      onclick={onnew}
    >
      +
    </button>
    <button
      type="button"
      class="cp-icon-btn"
      title="Close Comments"
      aria-label="Close Comments"
      onclick={onclose}
    >
      ×
    </button>
  </header>

  <div class="cp-filters" role="tablist" aria-label="Filter comments">
    <button
      type="button"
      role="tab"
      class="cp-filter-btn"
      class:active={filter === 'all'}
      aria-selected={filter === 'all'}
      onclick={() => (filter = 'all')}
    >
      All ({comments.length})
    </button>
    <button
      type="button"
      role="tab"
      class="cp-filter-btn"
      class:active={filter === 'discussion'}
      aria-selected={filter === 'discussion'}
      onclick={() => (filter = 'discussion')}
    >
      Discussions ({discussionCount})
    </button>
    <button
      type="button"
      role="tab"
      class="cp-filter-btn"
      class:active={filter === 'edit'}
      aria-selected={filter === 'edit'}
      onclick={() => (filter = 'edit')}
    >
      Edits ({editCount})
    </button>
  </div>

  {#if draft}
    <div class="comment-composer">
      <div class="cc-draft-top">
        <div class="cc-draft-anchor">
          {#if draft.to > draft.from && draft.snippet.trim()}
            <span class="cc-draft-quote">“{draft.snippet}”</span>
          {:else}
            <span class="cc-draft-point">Line {draft.line}</span>
          {/if}
        </div>
        <label class="cc-draft-author-wrap">
          <span class="cc-draft-at">@</span>
          <input
            type="text"
            class="cc-draft-author"
            bind:value={draftAuthor}
            placeholder="author"
            aria-label="Comment author"
          />
        </label>
      </div>

      <textarea
        bind:this={draftTextareaEl}
        bind:value={draftBody}
        class="cc-draft-textarea"
        rows="3"
        placeholder="Write a comment…"
        aria-label="New comment text"
        onkeydown={draftKeydown}
      ></textarea>

      <div class="cc-draft-actions">
        <button
          type="button"
          class="cc-btn-discussion"
          disabled={!draftBody.trim()}
          title="Post as threaded discussion (Ctrl+Enter)"
          onclick={() => submitDraft('discussion')}
        >
          Discussion
        </button>
        <button
          type="button"
          class="cc-btn-edit"
          disabled={!draftBody.trim()}
          title="Post as single edit note (Ctrl+Shift+Enter)"
          onclick={() => submitDraft('edit')}
        >
          Edit
        </button>
        <button
          type="button"
          class="cc-btn-cancel"
          title="Cancel (Esc)"
          onclick={oncanceldraft}
        >
          Cancel
        </button>
      </div>
    </div>
  {/if}

  <div class="cp-body" bind:this={listEl}>
    {#if visibleComments.length === 0}
      <div class="cp-empty">
        <p class="cp-empty-title">
          {comments.length === 0
            ? 'No comments in this note yet'
            : `No ${filter === 'discussion' ? 'discussions' : 'edits'} in this note`}
        </p>
        {#if !draft}
          <p class="cp-empty-hint">
            Select text or place cursor and press <kbd>Alt C</kbd>.
          </p>
          {#if canAdd}
            <button type="button" class="cp-add-btn" onclick={onnew}>+ Add comment</button>
          {/if}
        {/if}
      </div>
    {:else}
      {#each visibleComments as comment (comment.id)}
        {@const primary = comment.messages[0]}
        {@const replies = comment.kind === 'discussion' ? comment.messages.slice(1) : []}
        <article
          class="comment-card"
          class:is-discussion={comment.kind === 'discussion'}
          class:is-edit={comment.kind === 'edit'}
          class:is-active={activeId === comment.id}
          data-comment-id={comment.id}
        >
          <div class="cc-top">
            <span class="cc-pill" class:is-discussion={comment.kind === 'discussion'} class:is-edit={comment.kind === 'edit'}>
              {comment.kind === 'discussion' ? 'Discussion' : 'Edit'}
            </span>
            <span class="cc-line">
              {comment.anchor ? `Ln ${comment.anchor.line}` : 'Unanchored'}
            </span>
            <span class="cp-grow"></span>
            <button
              type="button"
              class="cc-delete-btn"
              title="Delete comment"
              aria-label="Delete comment"
              onclick={() => ondelete(comment.id)}
            >
              Delete
            </button>
          </div>

          {#if comment.anchor}
            <button
              type="button"
              class="cc-anchor-btn"
              title="Jump to comment in document"
              onclick={() => onselect(comment)}
            >
              {#if comment.anchor.isRange && comment.anchor.snippet.trim()}
                <span class="cc-quote">“{comment.anchor.snippet}”</span>
              {:else}
                <span class="cc-point">Point comment · Line {comment.anchor.line}</span>
              {/if}
            </button>
          {/if}

          {#if primary}
            <div class="cc-msg">
              <div class="cc-msg-meta">
                <span class="cc-author">@{primary.author}</span>
                <span class="cc-date">{primary.date}</span>
                <span class="cp-grow"></span>
                {#if editingKey !== `${comment.id}:0`}
                  <button
                    type="button"
                    class="cc-link-btn"
                    onclick={() => beginEdit(comment.id, 0, primary.body)}
                  >
                    Edit
                  </button>
                {/if}
              </div>

              {#if editingKey === `${comment.id}:0`}
                <div class="cc-edit-box">
                  <textarea
                    class="cc-edit-input"
                    rows="3"
                    bind:value={editDraft}
                    aria-label="Edit comment text"
                  ></textarea>
                  <div class="cc-edit-actions">
                    <button type="button" class="cc-small-btn" onclick={cancelEdit}>Cancel</button>
                    <button
                      type="button"
                      class="cc-small-btn primary"
                      disabled={!editDraft.trim()}
                      onclick={() => saveEdit(comment.id, 0)}
                    >
                      Save
                    </button>
                  </div>
                </div>
              {:else}
                <p class="cc-msg-body">{primary.body}</p>
              {/if}
            </div>
          {/if}

          {#if comment.kind === 'discussion'}
            {#if replies.length > 0}
              <div class="cc-replies">
                {#each replies as reply, idx (idx)}
                  {@const msgIndex = idx + 1}
                  {@const editKey = `${comment.id}:${msgIndex}`}
                  <div class="cc-reply">
                    <div class="cc-msg-meta">
                      <span class="cc-author">@{reply.author}</span>
                      <span class="cc-date">{reply.date}</span>
                      <span class="cp-grow"></span>
                      {#if editingKey !== editKey}
                        <button
                          type="button"
                          class="cc-link-btn"
                          onclick={() => beginEdit(comment.id, msgIndex, reply.body)}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          class="cc-reply-del"
                          title="Delete reply"
                          aria-label="Delete reply"
                          onclick={() => ondeletereply(comment.id, msgIndex)}
                        >
                          ×
                        </button>
                      {/if}
                    </div>
                    {#if editingKey === editKey}
                      <div class="cc-edit-box">
                        <textarea
                          class="cc-edit-input"
                          rows="2"
                          bind:value={editDraft}
                          aria-label="Edit reply text"
                        ></textarea>
                        <div class="cc-edit-actions">
                          <button type="button" class="cc-small-btn" onclick={cancelEdit}>Cancel</button>
                          <button
                            type="button"
                            class="cc-small-btn primary"
                            disabled={!editDraft.trim()}
                            onclick={() => saveEdit(comment.id, msgIndex)}
                          >
                            Save
                          </button>
                        </div>
                      </div>
                    {:else}
                      <p class="cc-msg-body">{reply.body}</p>
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}

            <form
              class="cc-reply-form"
              onsubmit={(e) => {
                e.preventDefault()
                submitReply(comment.id)
              }}
            >
              <textarea
                class="cc-reply-input"
                rows="1"
                placeholder="Write a reply…"
                aria-label="Write a reply"
                value={replyDrafts[comment.id] ?? ''}
                oninput={(e) =>
                  (replyDrafts = { ...replyDrafts, [comment.id]: e.currentTarget.value })}
                onkeydown={(e) => replyKeydown(comment.id, e)}
              ></textarea>
              <button
                type="submit"
                class="cc-reply-send"
                disabled={!(replyDrafts[comment.id] ?? '').trim()}
              >
                Reply
              </button>
            </form>
          {/if}
        </article>
      {/each}
    {/if}
  </div>
</div>

<style>
  .cp-wrap {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    min-width: 0;
  }
  .cp-head {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 9px 10px;
    border-bottom: 1px solid var(--border-soft);
  }
  .cp-title {
    font-size: 10.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
  }
  .cp-count {
    font-size: 11px;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: 999px;
    background: var(--panel);
    color: var(--text-muted);
    border: 1px solid var(--border-soft);
  }
  .cp-grow {
    flex: 1;
  }
  .cp-icon-btn {
    border: 0;
    background: transparent;
    color: var(--text-muted);
    border-radius: 6px;
    width: 24px;
    height: 24px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
  }
  .cp-icon-btn:hover:not(:disabled) {
    background: var(--hover);
    color: var(--text-primary);
  }
  .cp-icon-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .cp-filters {
    display: flex;
    gap: 4px;
    padding: 7px 10px;
    border-bottom: 1px solid var(--border-soft);
    background: var(--bg-chrome);
  }
  .cp-filter-btn {
    flex: 1;
    border: 1px solid transparent;
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: 11px;
    font-weight: 600;
    padding: 4px 6px;
    border-radius: 6px;
    cursor: pointer;
    white-space: nowrap;
  }
  .cp-filter-btn:hover {
    color: var(--text-primary);
    background: var(--hover);
  }
  .cp-filter-btn.active {
    background: var(--bg-app);
    color: var(--text-primary);
    border-color: var(--border-soft);
  }
  .cp-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .cp-empty {
    margin: auto 0;
    padding: 20px 14px;
    text-align: center;
    color: var(--text-muted);
  }
  .cp-empty-title {
    margin: 0 0 6px;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
  }
  .cp-empty-hint {
    margin: 0 0 12px;
    font-size: 12px;
    line-height: 1.45;
  }
  .cp-add-btn {
    padding: 6px 12px;
    border-radius: 7px;
    border: 1px solid var(--border-soft);
    background: var(--bg-app);
    color: var(--text-primary);
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }
  .cp-add-btn:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .comment-card {
    display: flex;
    flex-direction: column;
    gap: 7px;
    padding: 10px 11px;
    border-radius: 9px;
    border: 1px solid var(--border-soft);
    border-left-width: 3px;
    background: var(--bg-app);
    transition: border-color 0.12s ease, box-shadow 0.12s ease;
  }
  .comment-card.is-discussion {
    border-left-color: var(--warn-fg);
  }
  .comment-card.is-edit {
    border-left-color: var(--info-fg);
  }
  .comment-card.is-active {
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 28%, transparent);
    border-color: var(--accent);
  }
  .cc-top {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .cc-pill {
    font-size: 10.5px;
    font-weight: 700;
    padding: 2px 7px;
    border-radius: 999px;
    border: 1px solid transparent;
  }
  .cc-pill.is-discussion {
    background: var(--warn-bg);
    color: var(--warn-fg);
    border-color: var(--warn-border);
  }
  .cc-pill.is-edit {
    background: var(--info-bg);
    color: var(--info-fg);
    border-color: var(--info-border);
  }
  .cc-line {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
  }
  .cc-delete-btn {
    border: 0;
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: 11px;
    padding: 2px 6px;
    border-radius: 5px;
    cursor: pointer;
  }
  .cc-delete-btn:hover {
    background: var(--danger-bg);
    color: var(--danger-fg);
  }
  .cc-anchor-btn {
    display: block;
    width: 100%;
    text-align: left;
    border: 0;
    padding: 5px 8px;
    border-radius: 6px;
    background: var(--panel);
    color: var(--text-primary);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .cc-anchor-btn:hover {
    background: var(--hover);
  }
  .cc-quote {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    font-style: italic;
  }
  .cc-point {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
  }
  .cc-msg {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .cc-msg-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--text-muted);
  }
  .cc-author {
    font-weight: 600;
    color: var(--text-primary);
  }
  .cc-link-btn,
  .cc-reply-del {
    border: 0;
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: 11px;
    padding: 1px 4px;
    border-radius: 4px;
    cursor: pointer;
  }
  .cc-link-btn:hover {
    color: var(--text-primary);
    background: var(--hover);
  }
  .cc-reply-del:hover {
    color: var(--danger-fg);
    background: var(--danger-bg);
  }
  .cc-msg-body {
    margin: 0;
    font-size: 12.5px;
    line-height: 1.48;
    color: var(--text-primary);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .cc-replies {
    display: flex;
    flex-direction: column;
    gap: 7px;
    padding-left: 10px;
    margin-left: 2px;
    border-left: 2px solid var(--border-soft);
  }
  .cc-reply {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .cc-edit-box {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 2px;
  }
  .cc-edit-input {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    padding: 6px 8px;
    border-radius: 6px;
    border: 1px solid var(--border-soft);
    background: var(--bg-sidebar);
    color: var(--text-primary);
    font: inherit;
    font-size: 12.5px;
  }
  .cc-edit-actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
  }
  .cc-small-btn {
    border: 1px solid var(--border-soft);
    background: var(--bg-app);
    color: var(--text-primary);
    font: inherit;
    font-size: 11px;
    padding: 3px 9px;
    border-radius: 5px;
    cursor: pointer;
  }
  .cc-small-btn.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .cc-reply-form {
    display: flex;
    align-items: flex-end;
    gap: 6px;
    padding-top: 4px;
    border-top: 1px solid var(--border-soft);
  }
  .cc-reply-input {
    flex: 1;
    min-width: 0;
    resize: none;
    padding: 5px 8px;
    border-radius: 6px;
    border: 1px solid var(--border-soft);
    background: var(--bg-sidebar);
    color: var(--text-primary);
    font: inherit;
    font-size: 12px;
    line-height: 1.4;
  }
  .cc-reply-input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .cc-reply-send {
    border: 1px solid var(--border-soft);
    background: var(--panel);
    color: var(--text-primary);
    font: inherit;
    font-size: 11.5px;
    font-weight: 600;
    padding: 5px 9px;
    border-radius: 6px;
    cursor: pointer;
  }
  .cc-reply-send:hover:not(:disabled) {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .cc-reply-send:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .comment-composer {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 11px;
    border-bottom: 1px solid var(--border-soft);
    background: var(--bg-app);
  }
  .cc-draft-top {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .cc-draft-anchor {
    flex: 1;
    min-width: 0;
    padding: 4px 7px;
    border-radius: 6px;
    border-left: 2.5px solid var(--accent);
    background: var(--panel);
    font-size: 11.5px;
    color: var(--text-primary);
  }
  .cc-draft-quote {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    font-style: italic;
  }
  .cc-draft-point {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
  }
  .cc-draft-author-wrap {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 3px 6px;
    border: 1px solid var(--border-soft);
    border-radius: 6px;
    background: var(--bg-sidebar);
    flex-shrink: 0;
  }
  .cc-draft-at {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
  }
  .cc-draft-author {
    border: 0;
    background: transparent;
    color: var(--text-primary);
    font: inherit;
    font-size: 11.5px;
    width: 78px;
    outline: none;
  }
  .cc-draft-textarea {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    min-height: 68px;
    padding: 7px 9px;
    border-radius: 7px;
    border: 1px solid var(--border-soft);
    background: var(--bg-sidebar);
    color: var(--text-primary);
    font: inherit;
    font-size: 12.5px;
    line-height: 1.45;
  }
  .cc-draft-textarea:focus {
    outline: none;
    border-color: var(--accent);
  }
  .cc-draft-actions {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .cc-btn-discussion,
  .cc-btn-edit,
  .cc-btn-cancel {
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    padding: 5px 10px;
    border-radius: 6px;
    cursor: pointer;
    border: 1px solid transparent;
  }
  .cc-btn-discussion {
    background: var(--warn-bg);
    color: var(--warn-fg);
    border-color: var(--warn-border);
  }
  .cc-btn-discussion:hover:not(:disabled) {
    filter: brightness(0.95);
  }
  .cc-btn-edit {
    background: var(--info-bg);
    color: var(--info-fg);
    border-color: var(--info-border);
  }
  .cc-btn-edit:hover:not(:disabled) {
    filter: brightness(0.95);
  }
  .cc-btn-discussion:disabled,
  .cc-btn-edit:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .cc-btn-cancel {
    margin-left: auto;
    background: transparent;
    color: var(--text-muted);
  }
  .cc-btn-cancel:hover {
    background: var(--hover);
    color: var(--text-primary);
  }
</style>
