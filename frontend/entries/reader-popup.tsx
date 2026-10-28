import "@ui/install-pointer-dedupe";
import { createRoot } from "react-dom/client";
import "@radix-ui/themes/styles.css";
import "../kit/kit.css";
import "../texthooker/App.css";
import "../texthooker/popover.css";
import Providers from "./providers";
import PopoverApp from "../texthooker/PopoverApp";
createRoot(document.getElementById("root")!).render(
  <Providers transparent>
    <PopoverApp />
  </Providers>,
);
