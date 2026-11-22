/* global document, window, location */
// Shared tag editor for local hub cards and the board chrome. Peer cards are read-only.
(() => {
  const configuredPeople = (root) => {
    const globalList = window["lavishNotifyPeople"];
    if (Array.isArray(globalList)) {
      return globalList.filter((name) => typeof name === "string" && name.trim());
    }
    if (root?.dataset.people) {
      try {
        const parsed = JSON.parse(root.dataset.people);
        if (Array.isArray(parsed)) return parsed.filter((name) => typeof name === "string" && name.trim());
      } catch {
        // ignore invalid attribute
      }
    }
    return [];
  };
  const escape = (value) =>
    String(value).replace(
      /[&<>"']/g,
      (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
    );

  const tagEditor = (root) => /** @type {HTMLDetailsElement | null} */ (root.querySelector(".tag-editor"));
  const metadataDetails = (root) => /** @type {HTMLDetailsElement | null} */ (root.querySelector(".metadata-details"));
  const tagInput = (root) => /** @type {HTMLInputElement | null} */ (root.querySelector(".tag-form input"));
  const tagForm = (root) => /** @type {HTMLFormElement | null} */ (root.querySelector("form.tag-form"));

  /** @param {HTMLElement} root */
  function render(root, metadata, restored = null) {
    const wasOpen = restored?.open ?? tagEditor(root)?.open === true;
    const detailsOpen = metadataDetails(root)?.open === true;
    const priorInput = tagInput(root);
    const draft = restored?.draft ?? priorInput?.value ?? "";
    const previousTag = restored?.previousTag ?? tagForm(root)?.dataset.previousTag ?? "";
    root.dataset.metadata = JSON.stringify(metadata);
    const tags = metadata.tags || [];
    const readonly = root.dataset.readonly === "true";
    const actionLabel = String(root.dataset.actionLabel || "").trim() || "Send";
    const people = [...new Map(configuredPeople(root).map((name) => [name.toLowerCase(), name])).values()];
    const needsInput = tags.some((tag) => String(tag).toLowerCase() === "needs-input");
    const stateLabel =
      metadata.board_state_label ||
      (metadata.cancelled ? "Cancelled" : metadata.closed ? "Done" : needsInput ? "Needs input" : "Working");
    root.innerHTML =
      (root.dataset.chrome === "true"
        ? `<span class="board-workflow-state" role="status">${escape(stateLabel)}</span>`
        : "") +
      `<p class="metadata-notice" role="status"${root.dataset.tagResult ? "" : " hidden"}>${escape(root.dataset.tagResult || "")}</p>` +
      `<details class="tag-editor"${wasOpen ? " open" : ""}><summary>Edit tags</summary>` +
      `<p class="tag-label">Tags on this board</p><div class="board-tags">${tags.length ? tags.map((tag) => (readonly ? `<span class="board-tag">${escape(tag)}</span>` : `<span class="board-tag"><button type="button" data-edit="${escape(tag)}" title="Change tag ${escape(tag)}">${escape(tag)}</button><button type="button" data-remove="${escape(tag)}" aria-label="Remove ${escape(tag)}">×</button></span>`)).join("") : "<span>No tags yet</span>"}</div>` +
      (readonly
        ? `<p>Open this board on its hub to edit tags.</p>`
        : `<p class="tag-label">Add a person</p><p class="tag-help">Tagging a person notifies them when their tag notifications are enabled.</p><div class="person-tags">${people
            .map((name) => {
              const applied = tags.some((tag) => tag.toLowerCase() === name.toLowerCase());
              return `<button type="button" data-person="${escape(name)}" aria-pressed="${applied}">${applied ? "✓" : "+"} ${escape(name)}</button>`;
            })
            .join(
              "",
            )}</div><p class="tag-label">Board attention</p><button type="button" data-needs-input aria-pressed="${needsInput}">${needsInput ? "✓" : "+"} Needs input</button><form class="tag-form" data-previous-tag="${escape(previousTag)}"><input name="tag" aria-label="Tag" placeholder="Add a tag" maxlength="64" value="${escape(draft)}" required><button type="submit">${previousTag ? "Change tag" : "Add tag"}</button><button type="button" data-cancel${previousTag ? "" : " hidden"}>Cancel change</button></form>`) +
      `</details>` +
      (root.dataset.chrome === "true"
        ? `<details class="metadata-details"${detailsOpen ? " open" : ""}><summary>Details</summary><div class="metadata-dropdown"><p class="board-provenance">Created by ${escape(metadata.creator || "Unknown")} · ${metadata.created_version ? `Created on ${escape(metadata.created_version)}` : "Created before version tracking"} · ${metadata.served_version ? `Last served on ${escape(metadata.served_version)}` : "Last served before version tracking"}</p><p class="board-provenance">${escape(root.dataset.file || "")}</p></div></details>`
        : "");
    const lifecycle = document.getElementById?.("boardLifecycle");
    if (root.dataset.chrome === "true" && lifecycle) {
      lifecycle.innerHTML = metadata.closed
        ? `<button type="button" data-lifecycle-close>Reopen</button>`
        : `<div class="workflow-group"><span>Start work</span><button type="button" class="board-workflow-action" data-lifecycle-work>${escape(actionLabel)}</button></div><div class="session-group"><span>Session</span><button type="button" data-lifecycle-close>Close board</button><button type="button" data-lifecycle-cancel>Cancel board</button></div>`;
      if (!metadata.closed && lifecycle.dataset.endDisabled === "true") {
        for (const button of lifecycle.querySelectorAll("[data-lifecycle-close], [data-lifecycle-cancel]")) {
          /** @type {HTMLButtonElement} */ (button).disabled = true;
        }
      }
    }
  }

  const editorStates = new Map();
  function mount() {
    for (const root of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("[data-board-metadata]"))) {
      if (!root.dataset.mounted) {
        root.dataset.mounted = "true";
        const saved = editorStates.get(root.dataset.boardMetadata);
        if (saved) root.dataset.tagResult = saved.result;
        render(root, JSON.parse(root.dataset.metadata || "{}"), saved);
      }
    }
  }

  function rerenderAll() {
    for (const root of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("[data-board-metadata]"))) {
      if (root.contains(document.activeElement)) continue;
      render(root, JSON.parse(root.dataset.metadata || "{}"));
    }
  }

  /** @param {HTMLElement} root */
  async function save(root, patch) {
    const notice = /** @type {HTMLElement} */ (root.querySelector(".metadata-notice"));
    try {
      const response = await fetch(`/api/${encodeURIComponent(root.dataset.boardMetadata)}/metadata`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not save tags");
      const parts = [];
      if (patch.add?.length) parts.push("Added " + patch.add.join(", "));
      if (patch.remove?.length) parts.push("Removed " + patch.remove.join(", "));
      root.dataset.tagResult = parts.join(" · ");
      const input = tagInput(root);
      if (input) input.value = "";
      const form = tagForm(root);
      if (form) delete form.dataset.previousTag;
      render(root, { ...JSON.parse(root.dataset.metadata || "{}"), ...result });
      window.dispatchEvent(
        new CustomEvent("lavish:metadata-saved", { detail: { key: root.dataset.boardMetadata, ...result } }),
      );
    } catch (error) {
      notice.textContent = error.message;
      notice.hidden = false;
    }
  }

  async function reactivate(button, key, file) {
    button.disabled = true;
    try {
      const response = await fetch("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file, reopen: true }),
      });
      if (!response.ok) throw new Error("Could not reactivate board. Try again.");
      location.assign(`/session/${encodeURIComponent(key)}`);
    } catch (error) {
      button.disabled = false;
      button.textContent = error.message;
    }
  }

  document.addEventListener("click", async (event) => {
    const reactivateButton = /** @type {HTMLButtonElement} */ (
      /** @type {HTMLElement} */ (event.target).closest?.("[data-reactivate]")
    );
    if (reactivateButton) {
      await reactivate(reactivateButton, reactivateButton.dataset.key, reactivateButton.dataset.file);
      return;
    }
    const target = /** @type {HTMLElement} */ (event.target);
    const lifecycleButton = target.closest?.("#boardLifecycle button");
    const button = /** @type {HTMLButtonElement} */ (
      lifecycleButton || target.closest?.("[data-board-metadata] button")
    );
    if (!button || button.disabled) return;
    const root = /** @type {HTMLElement} */ (
      lifecycleButton
        ? document.querySelector('[data-board-metadata][data-chrome="true"]')
        : button.closest("[data-board-metadata]")
    );
    if (!root) return;
    const metadata = JSON.parse(root.dataset.metadata || "{}");
    if (button.dataset.remove) await save(root, { remove: [button.dataset.remove] });
    else if (button.hasAttribute("data-needs-input")) {
      const active = (metadata.tags || []).some((tag) => String(tag).toLowerCase() === "needs-input");
      await save(root, active ? { remove: ["needs-input"] } : { add: ["needs-input"] });
    } else if (button.dataset.person) {
      const name = button.dataset.person;
      await save(
        root,
        metadata.tags.some((tag) => tag.toLowerCase() === name.toLowerCase()) ? { remove: [name] } : { add: [name] },
      );
    } else if (button.dataset.edit) {
      const form = root.querySelector("form");
      root.querySelector("details").open = true;
      form.dataset.previousTag = button.dataset.edit;
      /** @type {HTMLInputElement} */ (form.elements.namedItem("tag")).value = button.dataset.edit;
      form.querySelector('[type="submit"]').textContent = "Change tag";
      /** @type {HTMLButtonElement} */ (form.querySelector("[data-cancel]")).hidden = false;
      /** @type {HTMLInputElement} */ (form.elements.namedItem("tag")).focus();
      /** @type {HTMLInputElement} */ (form.elements.namedItem("tag")).select();
    } else if (button.hasAttribute("data-cancel")) {
      const form = tagForm(root);
      if (form) delete form.dataset.previousTag;
      const input = tagInput(root);
      if (input) input.value = "";
      render(root, metadata);
    } else if (button.hasAttribute("data-workflow-action") || button.hasAttribute("data-lifecycle-work")) {
      const notice = /** @type {HTMLElement} */ (root.querySelector(".metadata-notice"));
      const chatInput = /** @type {HTMLTextAreaElement | null} */ (document.getElementById("chatInput"));
      const typed = chatInput ? chatInput.value.trim() : "";
      const composerAttachments = window["lavishChatAttachments"];
      if (composerAttachments?.hasPending() || composerAttachments?.hasErrors()) {
        composerAttachments.noteSendBlocked();
        return;
      }
      const attachments = composerAttachments?.collectReady() || [];
      button.disabled = true;
      try {
        const response = await fetch(`/api/${encodeURIComponent(root.dataset.boardMetadata)}/action`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...(typed ? { prompt: typed } : {}),
            ...(attachments.length ? { attachments } : {}),
          }),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || "Could not send action");
        if (typed && chatInput?.value.trim() === typed) chatInput.value = "";
        composerAttachments?.reset(attachments);
        render(root, { ...metadata, ...result });
        const freshNotice = /** @type {HTMLElement | null} */ (root.querySelector(".metadata-notice"));
        if (freshNotice) {
          freshNotice.textContent = `${result.action_label || root.dataset.actionLabel || "Send"} sent.`;
          freshNotice.hidden = false;
        }
      } catch (error) {
        notice.textContent = error.message;
        notice.hidden = false;
        button.disabled = false;
      }
    } else if (button.hasAttribute("data-cancel-board") || button.hasAttribute("data-lifecycle-cancel")) {
      button.disabled = true;
      try {
        const response = await fetch(`/api/hub/${encodeURIComponent(root.dataset.boardMetadata)}/cancel`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        if (!response.ok) throw new Error("Could not cancel board");
        render(root, {
          ...metadata,
          closed: true,
          cancelled: true,
          board_state: "cancelled",
          board_state_label: "Cancelled",
        });
      } catch (error) {
        const notice = /** @type {HTMLElement} */ (root.querySelector(".metadata-notice"));
        notice.textContent = error.message;
        notice.hidden = false;
        button.disabled = false;
      }
    } else if (button.hasAttribute("data-close") || button.hasAttribute("data-lifecycle-close")) {
      if (metadata.closed) {
        await reactivate(button, root.dataset.boardMetadata, root.dataset.file);
        return;
      }
      button.disabled = true;
      try {
        const response = await fetch(`/api/hub/${encodeURIComponent(root.dataset.boardMetadata)}/close`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        if (!response.ok) throw new Error("Could not change board state");
        render(root, { ...metadata, closed: true, board_state: "done", board_state_label: "Done" });
      } catch (error) {
        const notice = /** @type {HTMLElement} */ (root.querySelector(".metadata-notice"));
        notice.textContent = error.message;
        notice.hidden = false;
        button.disabled = false;
      }
    }
  });
  document.addEventListener("submit", (event) => {
    const form = /** @type {HTMLFormElement} */ (event.target);
    if (!form.matches?.(".tag-form")) return;
    event.preventDefault();
    save(/** @type {HTMLElement} */ (form.closest("[data-board-metadata]")), {
      add: [/** @type {HTMLInputElement} */ (form.elements.namedItem("tag")).value],
      remove: form.dataset.previousTag ? [form.dataset.previousTag] : [],
    });
  });
  window.addEventListener("lavish:capture-metadata", () => {
    for (const root of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("[data-board-metadata]"))) {
      editorStates.set(root.dataset.boardMetadata, {
        open: tagEditor(root)?.open === true,
        draft: tagInput(root)?.value || "",
        result: root.dataset.tagResult || "",
        previousTag: tagForm(root)?.dataset.previousTag || "",
      });
    }
  });
  window.addEventListener("lavish:render-metadata", mount);
  window.addEventListener("lavish:notify-people", rerenderAll);
  window["lavishBoardMetadata"] = {
    update(metadata) {
      for (const root of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("[data-board-metadata]"))) {
        if (root.dataset.boardMetadata === metadata.key)
          render(root, { ...JSON.parse(root.dataset.metadata || "{}"), ...metadata });
      }
    },
  };
  mount();
})();
