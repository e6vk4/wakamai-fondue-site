<template>
	<div class="urlload">
		<input
			v-model.trim="fontUrl"
			type="text"
			inputmode="url"
			class="urlinput"
			placeholder="Or paste a Google Fonts or font file URL"
			aria-label="Font URL"
			autocomplete="off"
			spellcheck="false"
			:disabled="loading"
			@keydown.enter.prevent="loadFromUrl"
		/>
		<p v-if="loading" class="urlloader">Loading...</p>
		<p v-if="urlNote" class="urlnote" role="status">{{ urlNote }}</p>
	</div>
</template>

<script>
import { fetchFontFile, FontUrlError } from "../utils/fontUrl";

export default {
	props: { urlError: { type: String, default: "" } },
	emits: ["getFont", "update:urlError", "update:loading"],
	data() {
		return { fontUrl: "", loading: false, urlNote: "" };
	},
	watch: {
		loading(value) {
			this.$emit("update:loading", value);
		},
	},
	// Don't let a slow download outlive the component
	beforeUnmount() {
		this.controller?.abort();
	},
	methods: {
		clear() {
			this.controller?.abort(); // cancel a stale in-flight fetch so it can't overwrite a font loaded another way
			this.fontUrl = "";
			this.urlNote = "";
			this.loading = false;
			this.$emit("update:urlError", "");
		},
		async loadFromUrl() {
			if (!this.fontUrl || this.loading) return;

			this.loading = true;
			this.$emit("update:urlError", "");
			this.urlNote = "";
			this.controller = new AbortController();

			try {
				const { file, note } = await fetchFontFile(
					this.fontUrl,
					this.controller.signal,
					{ apiKey: import.meta.env.VITE_GOOGLE_FONTS_API_KEY }
				);
				this.urlNote = note;
				// Same shape a file input event has. preventDefault is stubbed
				// because the parent's getFont handler calls it on the event, and
				// a bare object would throw there
				this.$emit("getFont", {
					target: { files: [file] },
					preventDefault() {},
				});
			} catch (e) {
				if (e.name === "AbortError") return; // component was torn down
				this.$emit(
					"update:urlError",
					e instanceof FontUrlError
						? e.message
						: "Something went wrong loading that URL."
				);
			} finally {
				this.loading = false;
			}
		},
	},
};
</script>

<style scoped>
.urlload {
	position: relative;
	z-index: 1;
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 0.4rem;
	margin-top: 1.25rem;
	width: max(260px, 30vmin);
}

.urlinput {
	box-sizing: border-box;
	width: 100%;
	height: 28px;
	max-height: 28px;
	padding: 0 0.6em;
	border: 0px;
	border-radius: 4px;
	font-size: 0.85rem;
	color: inherit;
	background: var(--light-grey);
}

.urlloader,
.urlnote {
	margin-top: 1.25rem;
	text-align: center;
	position: relative;
	z-index: 1;
	font-size: 0.85rem;
	max-width: 80%;
	margin-left: auto;
	margin-right: auto;
}

.urlnote {
	color: var(--green);
}
</style>
