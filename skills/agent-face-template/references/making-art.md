# Making face art

A way to make a full face, from first picture to talking, blinking animated states, that has worked in practice. It uses an image model that can **edit** a picture you give it, and Python with Pillow for everything after.

The one idea that matters: **make every picture after the first by editing an existing one, never from a fresh prompt.** Separate generations drift: the face, hair and clothes change a little each time, and a face that changes between states looks broken.

## 1. Tools

- **An image model that edits a reference image and returns a transparent background.** One that works from the command line is the Codex CLI signed in with ChatGPT; its `image_generation` feature is on by default (`codex features list`). No API key is needed, but images count against the user's plan.
- **Python with Pillow**, plus `numpy` and `scipy` for the mouth and blink masks.
- **`face.cjs check`** after every change.

One Codex job per picture:

```bash
codex exec --skip-git-repo-check --ephemeral -s workspace-write -C <output folder> \
  -i <reference.png> -o <last-message.txt> \
  "Edit the attached image with your image generation tool and save the result as <name>.png in the current folder. <what to change>"
```

- `-i` takes several files, so put another option (here `-o`) between the last image and the prompt; otherwise the prompt is read as one more image.
- Expect a few minutes per picture, and an hourly limit on the plan (around ten an hour has been seen). When the limit is hit, jobs fail within seconds; run one by hand to read the real message. Plan work in batches. Never buy credits: tell the user and wait.
- Ask for a transparent background explicitly every time: "fully transparent background, no border, no text, empty space around the figure". The model can return real alpha this way, so no background removal is needed.

## 2. The first pictures

Write a full description of the character once and repeat it word for word in every prompt for the base set. Ask for several states in one picture, for example a 2×2 grid of four expressions, with "exactly the same character, face, hair, outfit, art style, scale and position" in each cell. Pictures made together drift less than pictures made apart.

Then slice the grid by its own size (models don't always return the size you asked for), and from here on edit instead of prompting:

- **A new state:** edit the closest existing state. "Keep everything identical; change one thing only: …"
- **A new look** (other clothes, a new setting): give two references, for example idle and happy, plus an explicit description of what changes. Make that look's idle picture first, then make each of its states as an edit of that idle picture.

## 3. One size, one scale

Keep one master still per state, then make every other file for that state from it, the same way:

1. Crop the figure to its alpha bounding box (alpha ≥ 24, so faint fringes don't count).
2. Scale it so every state has the same figure height. Scale by the grid cell, or for a later state by a matching existing state.
3. Bottom-align it on a 1024×1024 transparent canvas.

The files the face shows are made from these masters at 512 px, which is plenty on screen and keeps animated files small.

Review the whole set on a contact sheet over a light and a dark backdrop, and look at a 1:1 crop of hair edges on the dark one to catch halos.

## 4. Mouth frames for lip-sync

1. Edit the state's 1024 master: "Change one thing only: the mouth is open mid-word, as if talking (a little upper teeth and tongue); same expression."
2. For a state whose mouth is already open, do the reverse: ask for a closed mouth. The edit becomes the state's `still`, and the original becomes its `talk`.
3. The model re-renders the whole picture slightly, so **copy only the mouth back onto the original**:
   - Take the per-pixel difference between the two (largest change over R, G, B > 40) and label the blobs (`scipy.ndimage.label`).
   - Take the mouth blob's bounding box, padded about 10 px.
   - Make a mask: the thresholded difference, dilated and blurred, or a soft-edged ellipse over the box when stray changes near the mouth have to go too.
   - Paste the edited picture onto the original through that mask.
4. Resize the still and the open mouth to 512 px with `LANCZOS`, in exactly the same way, so they line up to the pixel.
5. Run `check`; it fails if a frame's size differs from its state's. Then judge alignment by eye, flipping between side-by-side crops of the two.

Make the mouth frames when you make each state, not in a second pass.

## 5. Animated states

Animation can be made from a single still with Pillow, without generating more art:

- **About 24–26 frames at 512×512**, looping every 2.5–3.5 s. Around 110 ms per frame suits most states; 130–150 ms suits slow ones (sleepy, bored, sad).
- **Motion** is a small affine transform anchored at the bottom centre: breathing (up to about 0.6% vertical stretch), a gentle tilt, bounces or shakes to suit the state. Before transforming, extend the bottom pixel row downwards, so a tilt never opens a gap at the cut-off edge.
- **Blinking:** generate one eyes-closed edit of the master and copy only the eye area back onto the original, the same way as the mouth (difference inside the face area, soft mask). Show it as half-closed / closed / half-closed frames of about 50 / 70 / 50 ms.
- **Saving:** `save_all=True, loop=0, lossless=False, quality≈90, method=4`. `method=6` is much slower for no visible gain. Expect roughly 1–2 MB per state.
- Pillow merges identical consecutive frames, and a WebP frame's duration reads correctly only after `seek(i)` and `load()`. Keep that in mind when you check timings.
- Prefer WebP over GIF: GIF transparency is on or off per pixel, so edges look jagged over a desktop.

For an animated state with mouth frames, set its `still` to the 512 master (closed mouth), so talking swaps cleanly between still and open frames.

## 6. Before you share anything

- Generated PNGs can carry generator metadata. Strip it before publishing a picture anywhere.
- The face is files in the agent's repo. If the art or the voice is personal, keep `.agent-face/` out of git.
