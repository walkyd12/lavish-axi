/* global document, window, location */
// Shared tag editor for local hub cards and the board chrome. Peer cards are read-only.
(() => {
  const configuredPeople = (root) => {
    if (root?.dataset.people) {
      try {
        const parsed = JSON.parse(root.dataset.people);
        if (Array.isArray(parsed)) return parsed.filter((name) => typeof name === "string" && name.trim());
      } catch {
        // ignore invalid attribute
      }
    }
    const globalList = window["lavishNotifyPeople"];
    return Array.isArray(globalList) ? globalList.filter((name) => typeof name === "string" && name.trim()) : [];
  };
  const escape = (value) =>
    String(value).replace(
      /[&<>"']/g,
      (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
    );

  /** @param {HTMLElement} root */
  function render(root, metadata) {
    root.dataset.metadata = JSON.stringify(metadata);
    const tags = metadata.tags || [];
    const readonly = root.dataset.readonly === "true";
    const actionLabel = String(root.dataset.actionLabel || "").trim() || "Send";
    const people = configuredPeople(root);
    const needsInput = tags.some((tag) => String(tag).toLowerCase() === "needs-input");
    const stateLabel =
      metadata.board_state_label ||
      (metadata.cancelled ? "Cancelled" : metadata.closed ? "Done" : needsInput ? "Needs input" : "Working");
    root.innerHTML =
      `<p class="board-provenance"><strong>${escape(stateLabel)}</strong> · Created by ${escape(metadata.creator || "Unknown")} · Created on ${escape(metadata.created_version || "unknown version")} · Last served on ${escape(metadata.served_version || "unknown version")}${metadata.version_behind ? " · <strong>Older Lavish version</strong>" : ""}</p>` +
      `<div class="board-tags">${tags.map((tag) => (readonly ? `<span class="board-tag">${escape(tag)}</span>` : `<span class="board-tag"><button type="button" data-edit="${escape(tag)}" title="Change tag ${escape(tag)}">${escape(tag)}</button><button type="button" data-remove="${escape(tag)}" aria-label="Remove ${escape(tag)}">×</button></span>`)).join("")}</div>` +
      (readonly
        ? ""
        : `<details class="tag-editor"><summary>Tags</summary><div class="person-tags"><button type="button" data-needs-input aria-pressed="${needsInput}">Needs input</button>${people.map((name) => `<button type="button" data-person="${escape(name)}" aria-pressed="${tags.some((tag) => tag.toLowerCase() === name.toLowerCase())}">${escape(name)}</button>`).join("")}</div><form class="tag-form"><input name="tag" aria-label="Tag" placeholder="Add a tag" maxlength="64" required><button type="submit">Add tag</button><button type="button" data-cancel hidden>Cancel change</button></form></details>`) +
      (root.dataset.chrome === "true"
        ? metadata.closed
          ? `<div class="board-lifecycle-actions"><button type="button" class="board-close" data-close>Reactivate board</button></div>`
          : `<div class="board-lifecycle-actions"><button type="button" class="board-workflow-action" data-workflow-action>${escape(actionLabel)}</button><button type="button" class="board-close" data-close>Close board</button><button type="button" class="board-cancel" data-cancel-board>Cancel board</button></div>`
        : "") +
      `<p class="metadata-notice" role="status" hidden></p>`;
  }

  function mount() {
    for (const root of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("[data-board-metadata]"))) {
      if (!root.dataset.mounted) {
        root.dataset.mounted = "true";
        render(root, JSON.parse(root.dataset.metadata || "{}"));
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
      render(root, result);
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
    const button = /** @type {HTMLButtonElement} */ (
      /** @type {HTMLElement} */ (event.target).closest?.("[data-board-metadata] button")
    );
    if (!button) return;
    const root = /** @type {HTMLElement} */ (button.closest("[data-board-metadata]"));
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
    } else if (button.hasAttribute("data-cancel")) render(root, metadata);
    else if (button.hasAttribute("data-workflow-action")) {
      const notice = /** @type {HTMLElement} */ (root.querySelector(".metadata-notice"));
      const chatInput = /** @type {HTMLTextAreaElement | null} */ (document.getElementById("chatInput"));
      const typed = chatInput ? chatInput.value.trim() : "";
      button.disabled = true;
      try {
        const response = await fetch(`/api/${encodeURIComponent(root.dataset.boardMetadata)}/action`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(typed ? { prompt: typed } : {}),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || "Could not send action");
        if (typed && chatInput) chatInput.value = "";
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
    } else if (button.hasAttribute("data-cancel-board")) {
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
    } else if (button.hasAttribute("data-close")) {
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
        render(root, { ...metadata, closed: true });
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
