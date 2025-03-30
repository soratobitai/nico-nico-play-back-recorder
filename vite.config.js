import { defineConfig } from "vite";
export default defineConfig({
    sourcemap: true,
})

// import { defineConfig } from "vite";
// export default defineConfig({
//     // optimizeDeps: {
//     //     exclude: ['@ffmpeg/ffmpeg']
//     // },
//     // build: {
//     //     rollupOptions: {
//     //         external: ['@ffmpeg/ffmpeg']
//     //     }
//     // },
//     optimizeDeps: {
//         exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util"],
//     },
//     build: {
//         sourcemap: false,
//         rollupOptions: {
//             output: {
//                 manualChunks: undefined
//             }
//         }
//     }
// });

// export default defineConfig({
//     optimizeDeps: {
//         include: ['worker.js']
//     },
//     build: {
//         rollupOptions: {
//             external: ['worker.js']
//         }
//     }
// });
