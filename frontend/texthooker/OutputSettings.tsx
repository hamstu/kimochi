import { Checkbox, Flex, Text, TextField } from "@radix-ui/themes";
import { useSetting } from "../bridge/useSetting";
import type { TexthookerSettings } from "../vendor/shared-types";
/** Existing Kimochi output bridges remain opt-in; intake no longer depends on either. */
export default function OutputSettings() {
  const [settings, save] = useSetting<TexthookerSettings>(
    "texthookerSettings",
    {
      copyToClipboard: false,
      sendToWebSocket: false,
      webSocketUrl: "ws://localhost:6677",
    },
  );
  return (
    <Flex direction="column" gap="3" p="3" className="texthooker-output">
      <Text size="1" weight="bold" color="gray" style={{ textTransform: "uppercase", letterSpacing: ".08em" }}>
        Output
      </Text>
      <Text size="2">
        Send OCR scans to other tools. These outputs work independently of the
        selected Texthooker input.
      </Text>
      <Text as="label" size="2">
        <Checkbox
          checked={settings.copyToClipboard}
          onCheckedChange={(value) =>
            void save({ ...settings, copyToClipboard: value === true })
          }
        />{" "}
        Copy scans to clipboard
      </Text>
      <Text as="label" size="2">
        <Checkbox
          checked={settings.sendToWebSocket}
          onCheckedChange={(value) =>
            void save({ ...settings, sendToWebSocket: value === true })
          }
        />{" "}
        Send scans over WebSocket
      </Text>
      {settings.sendToWebSocket && (
        <TextField.Root
          aria-label="WebSocket output URL"
          value={settings.webSocketUrl}
          onChange={(e) =>
            void save({ ...settings, webSocketUrl: e.target.value })
          }
        />
      )}
    </Flex>
  );
}
