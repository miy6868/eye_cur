# UniGaze-B

Source: https://github.com/ut-vision/UniGaze
Authors: Jiawei Qin, Xucong Zhang, Yusuke Sugano, UniGaze: Towards Universal Gaze Estimation via
Large-scale Pre-Training, WACV 2026.
Model license: ModelGo Attribution-NonCommercial-ResponsibleAI License 2.0 (MG-NC-RAI-2.0),
https://github.com/Xtra-Computing/ModelGo/blob/main/MGL/V2/MG-BY-NC-RAI/LICENSE
Weights: `unigaze_b16_joint.safetensors` from https://huggingface.co/UniGaze/UniGaze-models,
downloaded by `scripts/download_models.py` (not stored in this repository).

`unigaze.py` re-implements the inference path of the official `MAE_Gaze` / timm `VisionTransformer`
(`unigaze_easy/src/unigaze/models`) with plain torch, because the official code needs timm 0.3.2.
Parameter names match the official checkpoint. On random input the outputs match the official
code within 3e-7. Preprocessing follows the official `predict_gaze_video.py`: BGR→RGB, 0–1,
ImageNet mean/std. Output is [pitch, yaw] in radians in the normalized camera space.

Face normalization reference: https://github.com/xucong-zhang/ETH-XGaze/blob/master/demo.py
The six metric landmark coordinates in backend/tracker.py are from rows
[20, 23, 26, 29, 15, 19] of the official ETH-XGaze face_model.txt:
https://github.com/xucong-zhang/ETH-XGaze/blob/master/face_model.txt
These describe eye corners and nose corners; the virtual crop center weights their
two group centers equally. UniGaze uses the same normalization (focal 960, distance 600, 224×224).
