/**
 * The ModelPicker's only entry point (`docs/MODEL-PICKER.md`). Surfaces import
 * from `@/components/model-picker`, never from the files behind it.
 */
export {
  ModelPickerPanel,
  ModelPickerPopover,
  ProductModelPicker,
  type ModelPickerProps,
  type ModelPickerPopoverProps,
  type ModelPickerTriggerProps,
} from './model-picker';
export { acceptsPick, pickLabel, type ModelPick, type ModelPickerFilter } from './picker-model';
export { useModelPicker, type ModelPickerContextValue, type ModelPickerMode } from './picker-context';
export { useModelFavorites, type ModelFavorite } from '@/hooks/use-model-favorites';
export type { CatalogTarget } from '@/lib/catalog-target';
