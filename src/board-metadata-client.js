/* global document, window, location */
// Shared tag editor for local hub cards and the board chrome. Peer cards are read-only.
(() => {
  const people = ["Walker", "Broc", "Gibson", "Zach", "Roxanne"];
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
    root.innerHTML =
      `<p class="board-provenance">Created by ${escape(metadata.creator || "Unknown")} · Created on ${escape(metadata.created_version || "unknown version")} · Last served on ${escape(metadata.served_version || "unknown version")}${metadata.version_behind ? " · <strong>Older Lavish version</strong>" : ""}</p>` +
      `<div class="board-tags">${tags.map((tag) => (readonly ? `<span class="board-tag">${escape(tag)}</span>` : `<span class="board-tag"><button type="button" data-edit="${escape(tag)}" title="Change tag ${escape(tag)}">${escape(tag)}</button><button type="button" data-remove="${escape(tag)}" aria-label="Remove ${escape(tag)}">×</button></span>`)).join("")}</div>` +
      (readonly
        ? ""
        : `<details class="tag-editor"><summary>Tags</summary><div class="person-tags">${people.map((name) => `<button type="button" data-person="${name}" aria-pressed="${tags.some((tag) => tag.toLowerCase() === name.toLowerCase())}">${name}</button>`).join("")}</div><form class="tag-form"><input name="tag" aria-label="Tag" placeholder="Add a tag" maxlength="64" required><button type="submit">Add tag</button><button type="button" data-cancel hidden>Cancel change</button></form></details>`) +
      (root.dataset.chrome === "true"
        ? `<button type="button" class="board-close" data-close>${metadata.closed ? "Reactivate board" : "Close board"}</button>`
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
    else if (button.dataset.person) {
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
    else if (button.hasAttribute("data-close")) {
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
