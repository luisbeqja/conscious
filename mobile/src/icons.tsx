import Svg, { Circle, Path } from "react-native-svg";

interface IconProps {
    size?: number;
    color: string;
}

export const ArrowUp = ({ size = 18, color }: IconProps) => (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <Path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" stroke={color} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
);

export const Plus = ({ size = 22, color }: IconProps) => (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <Path d="M12 5v14M5 12h14" stroke={color} strokeWidth={2} strokeLinecap="round" />
    </Svg>
);

export const More = ({ size = 22, color }: IconProps) => (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
        <Circle cx={5} cy={12} r={1.8} />
        <Circle cx={12} cy={12} r={1.8} />
        <Circle cx={19} cy={12} r={1.8} />
    </Svg>
);

export const Close = ({ size = 14, color }: IconProps) => (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <Path d="M6 6l12 12M18 6 6 18" stroke={color} strokeWidth={2.6} strokeLinecap="round" />
    </Svg>
);

export const Document = ({ size = 22, color }: IconProps) => (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <Path
            d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"
            stroke={color}
            strokeWidth={1.8}
            strokeLinejoin="round"
        />
        <Path d="M14 3v5h5M9 13h6M9 17h4" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
);

export const ChevronDown = ({ size = 18, color }: IconProps) => (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <Path d="m6 9 6 6 6-6" stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
);
