import { mergeAttributes, Node, NodeViewProps } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import React, { useContext, useEffect, useRef, useState } from "react";
import ReactModal from "react-modal";
import ImageAnnotator from "../frontend/image_annotator";

declare module "@tiptap/core" {
    interface Commands<ReturnType> {
        evidence: {
            setEvidence: (options: { id: number }) => ReturnType;
        };
    }
}

type EvidenceOptions = {};
const Evidence = Node.create<EvidenceOptions>({
    name: "evidence",
    group: "block",
    draggable: true,

    addAttributes() {
        return {
            id: {
                default: null,
                parseHTML: (el) => el.getAttribute("data-evidence-id"),
                renderHTML: (attrs) => ({
                    "data-evidence-id": attrs.id,
                }),
            },
        };
    },

    parseHTML() {
        return [
            {
                tag: "div",
                getAttrs: (node) =>
                    node.classList.contains("richtext-evidence") && null,
            },
        ];
    },

    renderText({ node }) {
        return node.attrs.name ? "Evidence " + node.attrs.name : "Evidence";
    },

    renderHTML({ HTMLAttributes }) {
        return [
            "div",
            mergeAttributes(
                {
                    class: "richtext-evidence",
                },
                HTMLAttributes
            ),
        ];
    },

    addNodeView() {
        return ReactNodeViewRenderer(EvidenceView);
    },

    addCommands() {
        return {
            setEvidence:
                (options) =>
                ({ commands }) =>
                    commands.insertContent({
                        type: this.name,
                        attrs: options,
                    }),
        };
    },

    addKeyboardShortcuts() {
        return {
            "Mod-Shift-d": () =>
                this.editor.view.dom.dispatchEvent(
                    new CustomEvent("openevidencemodal")
                ),
        };
    },
});

export type Evidence = {
    id: number;
    friendlyName: string;
    caption: string;
    document: string;
};

export type Evidences = {
    evidence: Evidence[];
    uploadUrl: string;
    poll: () => Promise<void>;
    /** Change an evidence's report caption. Rejects with a user-facing message on failure. */
    updateCaption?: (id: number, caption: string) => Promise<void>;
    /** Replace an image evidence's file with an edited copy. Rejects with a user-facing message on failure. */
    replaceImage?: (id: number, image: Blob) => Promise<void>;
};

export const EvidencesContext = React.createContext<Evidences | null>(null);

const TEXT_EXTENSIONS = [".txt", ".log", ".md"];
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg"];

// Custom hook to fetch text content of an evidence if it's a text file
function useTextContent(id: number, isText: boolean): string | null {
    const [content, setContent] = React.useState<string | null>(null);
    React.useEffect(() => {
        if (!isText) return;
        fetch("/reporting/evidence/download/" + id)
            .then((r) => {
                if (!r.ok) throw new Error(r.statusText);
                return r.text();
            })
            .then(setContent)
            .catch(() => setContent(null));
    }, [id, isText]);
    return content;
}

function EvidenceView(props: NodeViewProps) {
    const id = parseInt(props.node.attrs.id);
    const ghostwriterEvidences = useContext(EvidencesContext);
    const evidence =
        ghostwriterEvidences &&
        ghostwriterEvidences.evidence.find((v) => v.id === id);
    const normalizedDocument = evidence?.document.toLowerCase() ?? "";

    const [lightboxOpen, setLightboxOpen] = useState(false);
    const [annotatorOpen, setAnnotatorOpen] = useState(false);

    const isImage =
        !!evidence &&
        IMAGE_EXTENSIONS.some((ext) => normalizedDocument.endsWith(ext));
    const isText =
        !!evidence &&
        TEXT_EXTENSIONS.some((ext) => normalizedDocument.endsWith(ext));
    const textContent = useTextContent(id, isText);

    if (!evidence) {
        return (
            <NodeViewWrapper className="richtext-evidence">
                <span className="richtext-evidence-missing">
                    « Evidence Missing »
                </span>
            </NodeViewWrapper>
        );
    }

    const editable = props.editor.isEditable;
    const replaceImage = ghostwriterEvidences?.replaceImage;
    const updateCaption = ghostwriterEvidences?.updateCaption;

    let preview = null;
    if (isImage) {
        // The stored file name changes when the image is replaced, so use it to bust the cache
        const url =
            "/reporting/evidence/download/" +
            evidence.id +
            "?v=" +
            encodeURIComponent(evidence.document);
        preview = (
            <>
                <img src={url} onClick={() => setLightboxOpen(true)} />
                {editable && replaceImage && (
                    <button
                        type="button"
                        className="richtext-evidence-action"
                        title="Censor sensitive details or highlight areas of this image"
                        onClick={() => setAnnotatorOpen(true)}
                    >
                        <i className="fas fa-highlighter" aria-hidden="true" />{" "}
                        Censor / highlight
                    </button>
                )}
                <ReactModal
                    isOpen={lightboxOpen}
                    onRequestClose={() => setLightboxOpen(false)}
                    contentLabel="Lightbox"
                    className="rich-text-lightbox"
                >
                    <img src={url} />
                </ReactModal>
                {annotatorOpen && replaceImage && (
                    <ImageAnnotator
                        source={url}
                        title={"Censor and highlight " + evidence.friendlyName}
                        saveLabel="Replace evidence image"
                        notice={
                            <>
                                Saving replaces this evidence file everywhere it
                                is used, and the original is deleted.
                            </>
                        }
                        onCancel={() => setAnnotatorOpen(false)}
                        onSave={async (blob) => {
                            await replaceImage(evidence.id, blob);
                            setAnnotatorOpen(false);
                        }}
                    />
                )}
            </>
        );
    } else if (isText) {
        preview = (
            <pre className="richtext-evidence-text">
                <code>{textContent === null ? "Loading…" : textContent}</code>
            </pre>
        );
    }

    return (
        <NodeViewWrapper className="richtext-evidence">
            <span className="richtext-evidence-name">
                {evidence.friendlyName}
            </span>
            {preview}
            {editable && updateCaption ? (
                <CaptionEditor
                    caption={evidence.caption}
                    onSave={(caption) => updateCaption(evidence.id, caption)}
                />
            ) : (
                <span className="richtext-evidence-caption">
                    {"Evidence: " + evidence.caption}
                </span>
            )}
        </NodeViewWrapper>
    );
}

const CAPTION_MAX_LENGTH = 255;

/** Click-to-edit caption shown under evidence in the editor. */
function CaptionEditor(props: {
    caption: string;
    onSave: (caption: string) => Promise<void>;
}) {
    const [editing, setEditing] = useState(false);
    const [value, setValue] = useState(props.caption);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const inputRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        if (editing) inputRef.current?.select();
    }, [editing]);

    // Pick up changes made by collaborators or on the evidence page while not editing
    useEffect(() => {
        if (!editing) setValue(props.caption);
    }, [props.caption, editing]);

    const cancel = () => {
        setValue(props.caption);
        setError(null);
        setEditing(false);
    };

    const commit = async () => {
        const trimmed = value.trim();
        if (trimmed === props.caption) {
            cancel();
            return;
        }
        if (!trimmed) {
            setError("A caption is required.");
            return;
        }
        setSaving(true);
        setError(null);
        try {
            await props.onSave(trimmed);
            setEditing(false);
        } catch (err) {
            setError(
                err instanceof Error ? err.message : "Could not save caption."
            );
        } finally {
            setSaving(false);
        }
    };

    if (!editing) {
        return (
            <button
                type="button"
                className="richtext-evidence-caption richtext-evidence-caption-button"
                title="Edit caption"
                onClick={() => setEditing(true)}
            >
                {"Evidence: " + props.caption}
                <i
                    className="fas fa-pencil-alt richtext-evidence-caption-icon"
                    aria-hidden="true"
                />
                <span className="visually-hidden"> (edit caption)</span>
            </button>
        );
    }

    return (
        <span className="richtext-evidence-caption-editor">
            <span className="richtext-evidence-caption-prefix">Evidence:</span>
            <input
                ref={inputRef}
                type="text"
                className={"form-control" + (error ? " is-invalid" : "")}
                aria-label="Evidence caption"
                maxLength={CAPTION_MAX_LENGTH}
                value={value}
                disabled={saving}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === "Enter") {
                        e.preventDefault();
                        commit();
                    } else if (e.key === "Escape") {
                        e.preventDefault();
                        cancel();
                    }
                }}
                onBlur={() => {
                    if (!saving) commit();
                }}
            />
            {saving && (
                <i className="fas fa-spinner fa-spin" aria-hidden="true" />
            )}
            {error && (
                <span className="richtext-evidence-caption-error" role="alert">
                    {error}
                </span>
            )}
        </span>
    );
}

export default Evidence;
