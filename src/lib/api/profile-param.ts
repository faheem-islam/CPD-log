import { z } from "zod";
import { PROFILE_IDS, type ProfileId } from "@/lib/types";

export const profileSchema = z.enum(PROFILE_IDS as unknown as [ProfileId, ...ProfileId[]], {
  message: "Choose ICE, IStructE or Custom.",
});
