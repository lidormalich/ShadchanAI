import mongoose, { Schema, Document, Types } from 'mongoose';

export interface ISetting extends Document {
  key: string;
  value: unknown;
  updatedAt: Date;
  updatedBy?: Types.ObjectId;
}

const settingSchema = new Schema<ISetting>(
  {
    key: { type: String, required: true, unique: true, index: true },
    value: { type: Schema.Types.Mixed, required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  {
    timestamps: true,
    collection: 'settings',
  },
);

export const Setting = mongoose.model<ISetting>('Setting', settingSchema);
