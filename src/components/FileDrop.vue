<template>
	<div class="filedrop">
		<label class="upload">
			<div class="background circle-background"></div>
			<input
				type="file"
				name="file"
				accept=".woff,.woff2,.ttf,.otf"
				@change="handleFileInput"
			/>
			<div class="info">
				<strong class="drop">Drop a font!</strong>
				<button
					type="button"
					class="button on"
					@click="
						handleExampleFont('NaNSuccessTitling-Variable.woff2')
					"
				>
					Try with NaN Success Titling
				</button>
				<LocalFontPicker
					:supported="localFontsSupported"
					:permission="localFontsPermission"
					@select="handleLocalFont"
					@permissionChange="
						$emit('localFontsPermissionChange', $event)
					"
				/>
				<FontURL
					ref="fontUrlInput"
					v-model:url-error="urlErrorMessage"
					v-model:loading="urlLoading"
					@getFont="handleUrlSuccess"
				/>
				<div
					class="errormessage"
					:class="{
						show: showErrorMessage,
					}"
					role="alert"
				>
					<strong
						>Oops! I couldn't handle that
						{{ urlErrorMessage ? "url" : "file" }}.</strong
					>
					<p v-if="urlErrorMessage">{{ urlErrorMessage }}</p>
					<p v-else-if="localFontError">
						⚠️ This is likely not a Wakamai Fondue error!
						<br />
						Local fonts can fail in many ways.
					</p>
					<a v-else href="mailto:brokenfonts@pixelambacht.nl"
						>Tell me about it so I can fix it</a
					>
				</div>
			</div>
		</label>
	</div>
</template>

<script>
import LocalFontPicker from "./LocalFontPicker.vue";
import FontURL from "./FontUrl.vue";

export default {
	data() {
		return {
			urlErrorMessage: "",
			urlLoading: false,
			suppressFileError: false,
		};
	},
	components: {
		LocalFontPicker,
		FontURL,
	},
	props: [
		"error",
		"localFontError",
		"localFontsSupported",
		"localFontsPermission",
	],
	emits: [
		"getFont",
		"getExampleFont",
		"loadLocalFont",
		"localFontsPermissionChange",
	],
	computed: {
		showErrorMessage() {
			// suppressFileError hides a stale file error after a successful URL load
			const hasVisibleFileError = this.error && !this.suppressFileError;
			const hasError = hasVisibleFileError || this.urlErrorMessage;
			return hasError && !this.urlLoading;
		},
	},
	methods: {
		resetForNewFileAttempt() {
			this.suppressFileError = false;
			this.$refs.fontUrlInput?.clear();
		},
		handleFileInput(event) {
			this.resetForNewFileAttempt();
			this.$emit("getFont", event);
		},
		handleExampleFont(name) {
			this.resetForNewFileAttempt();
			this.$emit("getExampleFont", name);
		},
		handleLocalFont(event) {
			this.resetForNewFileAttempt();
			this.$emit("loadLocalFont", event);
		},
		handleUrlSuccess(event) {
			this.suppressFileError = true;
			this.$emit("getFont", event);
		},
	},
};
</script>

<style scoped>
.filedrop {
	position: relative;
	z-index: 10; /* Must be above all other elements */
	height: 100%;
	width: 100%;
	display: flex;
	justify-content: center;
	align-items: center;
	transition: background 150ms;
}

.working .filedrop {
	pointer-events: none;
}

.background {
	position: absolute;
	top: 0;
	left: 0;
	right: 0;
	bottom: 0;
	background-size: contain;
	background-position: center;
	background-repeat: no-repeat;
	animation: weeee 20s linear infinite reverse;
}

.working .background {
	animation-duration: 1s;
	animation-direction: normal;
}

.upload {
	position: relative;
	width: max(300px, 50vmin);
	height: max(300px, 50vmin);
	max-width: 500px;
	max-height: 500px;
	transition: transform 150ms;
	cursor: pointer;
}

.upload::after {
	content: "";
	background: url("@/assets/logo.svg");
	position: absolute;
	top: -16%;
	left: -16%;
	width: 132%;
	height: 132%;
	animation: weeee var(--duration, 38s) linear infinite
		var(--direction, normal);
}

.working .upload::after {
	--duration: 1s;
	--direction: reverse;
}

/* scoped to the native file input specifically, so it doesn't hide the URL input */
.upload input[type="file"] {
	position: absolute;
	width: 0;
	height: 0;
	opacity: 0;
}

.info {
	position: relative;
	display: flex;
	flex-direction: column;
	justify-content: center;
	align-items: center;
	height: 100%;
	padding-top: 5rem;
	color: black;
}

.working .info {
	opacity: 0.25;
}

.info > strong {
	font-size: 2.25em;
	text-align: center;
}

.info button {
	margin-top: 1.25rem;
	/* Stacking tricks to prevent button click
    from being seen as label click */
	position: relative;
	z-index: 1;
}

.drop {
	z-index: 1;
}

.drop:hover {
	animation: schwoop 900ms step-end infinite;
}

@keyframes schwoop {
	0% {
		color: var(--red);
	}
	33.33% {
		color: var(--green);
	}
	66.66% {
		color: var(--yellow);
	}
}

.dragging .filedrop {
	position: fixed;
	background: rgba(0, 0, 0, 0.75);
	backdrop-filter: blur(7.5px);
}

.dragging .upload {
	transform: scale(1.1);
}

.errormessage {
	pointer-events: none;
	margin-top: 1.25rem;
	color: var(--red);
	opacity: 0;
	text-align: center;
	position: relative;
	z-index: 1;
	font-size: 0.85rem;
}

.errormessage strong {
	display: block;
	margin-bottom: 0.25em;
}

.errormessage p {
	white-space: pre-line;
}

.errormessage.show {
	pointer-events: auto;
	opacity: 1;
}

@keyframes weeee {
	to {
		transform: rotate(-1turn);
	}
}
</style>
