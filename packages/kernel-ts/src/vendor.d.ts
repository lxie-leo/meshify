// draco3dgltf（可选依赖）不自带类型；按其 UMD 导出形参声明最小接口
declare module 'draco3dgltf' {
	export interface Draco3dgltfModule {
		decoder: { ready: Promise<void> } & Record<string, unknown>;
		encoder: { ready: Promise<void> } & Record<string, unknown>;
	}
	const draco3dgltf: { createDecoderModule(): Draco3dgltfModule['decoder']; createEncoderModule(): Draco3dgltfModule['encoder'] };
	export default draco3dgltf;
}
