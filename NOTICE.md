# Notice

Laya RAG Judge (layaAsRagJudge) is an unofficial project built on a browser port of the Laya typed-decisions checkpoint. It is not affiliated with or endorsed by ConvAI Innovations, Microsoft, Hugging Face, Answer.AI, LightOn or the sentence-transformers authors.

## This project

The retrieval pipeline, vector store, evaluation harness, pages and sample corpus in this repository are Copyright 2026 vishalmysore and licensed under the Apache License, Version 2.0 (see `LICENSE`).

`web/corpus.json` was written for this demo. Every document describes a fictional place, organisation, person or policy; no text from any benchmark dataset is included. `web/recorded.json` holds results that the same models produced for that corpus, so the pages can show them before anything is downloaded.

## The models (downloaded at runtime, not part of this repository)

- **Judge:** [`convaiinnovations/laya-multilingual`](https://huggingface.co/convaiinnovations/laya-multilingual) (mmBERT-base, Copyright ConvAI Innovations, Apache-2.0), ONNX로 변환·양자화된 빌드를 https://realizer-1966.github.io/laya-web-ko/model-multilingual/ 에서 내려받습니다. Laya typed-decisions는 [`convaiinnovations/laya-typed-decisions`](https://huggingface.co/convaiinnovations/laya-typed-decisions) 계열이며 mmBERT-base(Microsoft)를 백본으로 사용합니다.
- **Retriever:** [`Xenova/paraphrase-multilingual-MiniLM-L12-v2`](https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2) (Apache-2.0), the ONNX export of [`sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`](https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2) (Apache-2.0).

`web/laya-core.js` and `web/model.js` are copied from layaForWeb / layaForWorkflows. `laya-core.js` is a JavaScript port of the Python `laya/common.py` (`build_sequence`) and `laya/agent.py` (`system_one`) from https://github.com/NandhaKishorM/laya (Apache-2.0).

## Third-party software shipped with the page (`vendor/`)

- **ONNX Runtime Web** (`onnxruntime-web` 1.30.0): Copyright (c) Microsoft Corporation, MIT License. `licenses/onnxruntime-LICENSE.txt`; notices for components inside the WebAssembly binary are in `licenses/onnxruntime-ThirdPartyNotices.txt`.
- **Tokenizers.js** (`@huggingface/tokenizers` 0.2.0): Hugging Face, Apache License 2.0. `licenses/tokenizers.js-LICENSE.txt`.
